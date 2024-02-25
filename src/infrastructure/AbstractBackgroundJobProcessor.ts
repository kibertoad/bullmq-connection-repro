import type { NewRelicTransactionManager } from '@lokalise/fastify-extras'
import type { ErrorReporter } from '@lokalise/node-core'
import { resolveGlobalErrorLogObject } from '@lokalise/node-core'
import { RedisOptions } from 'ioredis'
import type Redis from 'ioredis'
import type { Logger } from 'pino'
import pino from 'pino'
import {JobsOptions, Job, Queue, QueueOptions, Worker} from "bullmq";
import {randomUUID} from "crypto";
import {Dependencies} from "./diConfig";

/**
 * Default config
 * 	- Retry config: 3 retries with 30s of total amount of wait time between retries using
 * 			exponential strategy https://docs.bullmq.io/guide/retrying-failing-jobs#built-in-backoff-strategies
 * 	- Job retention: 3 days for completed jobs, 7 days for failed jobs
 */
const DEFAULT_JOB_CONFIG = {
	attempts: 3,
	backoff: {
		type: 'exponential',
		delay: 5000,
	},
	removeOnComplete: true,
	removeOnFail: true,
}

const QUEUE_IDS_KEY = 'background-jobs-common:background-job:queues'

const queueIdsSet = new Set<string>()

export type BackgroundJobProcessorConfig = {
	queueId: string
	isTest: boolean
	queueOptions?: Partial<QueueOptions>
	workerOptions?: Partial<WorkerOptions>
}

export type BackgroundJobProcessorDependencies = {
	redis: Redis
	newRelicBackgroundTransactionManager: NewRelicTransactionManager
	logger: Logger
	errorReporter: ErrorReporter
}


export abstract class AbstractBackgroundJobProcessor<JobData extends object, JobReturn = void> {
	protected readonly logger: Logger

	private readonly redis: Redis
	private readonly redisConfig: RedisOptions
	private readonly newRelicBackgroundTransactionManager: NewRelicTransactionManager
	private readonly errorReporter: ErrorReporter

	private queue?: Queue<JobData>
	private worker?: Worker<JobData>
	private config: BackgroundJobProcessorConfig

	protected constructor(
		dependencies: Dependencies,
		config: BackgroundJobProcessorConfig,
	) {
		this.config = config
		this.redisConfig = dependencies.config.redis
		this.redis = dependencies.redis
		this.newRelicBackgroundTransactionManager = dependencies.newRelicBackgroundTransactionManager
		this.logger = dependencies.logger
		this.errorReporter = dependencies.errorReporter
	}

	public async start(): Promise<void> {
		this.queue = new Queue(this.config.queueId, {
			connection: this.redis,
			...this.config.queueOptions,
		})
		await this.queue.waitUntilReady()

		this.worker = new Worker<JobData>(
			this.config.queueId,
			async (job: Job<JobData>) => {
				return await this.processInternal(job)
			},
			{
				connection: this.redis,
				...this.config.workerOptions,
			},
		)

		if (this.config.isTest) {
			await this.worker.waitUntilReady() // unlike queue, the docs for worker state that this is only useful in tests
		}
	}

	public async dispose(): Promise<void> {
		queueIdsSet.delete(this.config.queueId)
		if (this.redis.status === 'end') {
			return
		}

		// On test forcing the worker to close to not wait for current job to finish
		await this.worker?.close()
		await this.queue?.close()
	}

	public async schedule(jobData: JobData, options?: JobsOptions): Promise<string> {
		const job = await this.initializedQueue.add(
			this.constructor.name,
			jobData,
			this.prepareJobOptions(options ?? {}),
		)

		if (!job.id) {
			// Practically unreachable, but we want to simplify the signature of the method and avoid
			// stating that it could return undefined.
			throw new Error('Scheduled job ID is undefined')
		}

		return job.id
	}

	private prepareJobOptions(options: JobsOptions): JobsOptions {
		const preparedOptions: JobsOptions = {
			jobId: randomUUID(),
			...DEFAULT_JOB_CONFIG,
			...options,
		}

		return preparedOptions
	}

	// allowing greater method length because of the added return
	// eslint-disable-next-line max-statements
	private async processInternal(job: Job<JobData>) {
		const jobId = job.id ?? 'unknown'
		try {
			this.newRelicBackgroundTransactionManager.start(job.name)
			this.logger.info(`Started ${job.name} (${jobId})`)

			const result = await this.process(job)
			return result
		} catch (error) {
			this.logger.error(resolveGlobalErrorLogObject(error, jobId))

			if (error instanceof Error) {
				this.errorReporter.report({
					error,
					context: {
						id: jobId,
						errorJson: JSON.stringify(pino.stdSerializers.err(error)),
					},
				})
			}

			throw error
		} finally {
			this.logger.info(`Finished ${job.name} (${jobId})`)
			this.newRelicBackgroundTransactionManager.stop(job.name)
		}
	}

	private async handleLastAttemptError(job: Job<JobData>, error: unknown): Promise<void> {
		try {
			this.logger.info(`Running 'onFailed' ${job.name} (${job.id})`)
			await this.onFailed(job, error)
		} catch (error) {
			this.logger.error(resolveGlobalErrorLogObject(error, job.id))

			if (error instanceof Error) {
				this.errorReporter.report({
					error,
					context: {
						id: job.id,
						errorJson: JSON.stringify(pino.stdSerializers.err(error)),
					},
				})
			}
		}
		this.logger.info(`Finished 'onFailed' ${job.name} (${job.id})`)
	}

	private get initializedQueue(): Queue<JobData> {
		if (!this.queue) {
			throw new Error(
				'Queue is not initialized. Please call `start` method before scheduling jobs.',
			)
		}

		return this.queue
	}

	protected abstract process(job: Job<JobData>): Promise<JobReturn>
	protected abstract onFailed(_job: Job<JobData>, _error: unknown): Promise<void>
}

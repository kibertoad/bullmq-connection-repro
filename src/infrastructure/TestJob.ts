import {AbstractBackgroundJobProcessor} from "./AbstractBackgroundJobProcessor";
import {Job} from "bullmq";
import {Dependencies} from "./diConfig";
import {setTimeout} from "timers/promises";

export class TestJob extends AbstractBackgroundJobProcessor<any> {

    public constructor(dependencies: Dependencies) {
        super(dependencies, {
            queueId: 'queueId',
            isTest: true,
        })
    }

    protected async process(job: Job<any>): Promise<void> {
        await setTimeout(500)
    }

    protected onFailed(_job: Job<any>, _error: unknown): Promise<void> {
        return Promise.resolve();
    }

}

import type { FastifyInstance } from 'fastify'

import { setTimeout } from 'timers/promises'
import { getApp } from './app'

describe('jobs', () => {
  let app: FastifyInstance
  beforeAll(async () => {
    app = await getApp({
      monitoringEnabled: true,
    })

    afterAll(async () => {
      await app.close()
    })
  })

  describe('jobs', () => {
    it('disposes of jobs', async() => {
      for (let x = 0; x < 10000; x++)
      {
        void app.diContainer.cradle.job1.schedule({})
      }
      await setTimeout(1000)

      await setTimeout(1000)

      await setTimeout(1000)
    })
  })
})

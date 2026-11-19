import * as k8s from '@kubernetes/client-node'
import { mergePodSpecWithOptions } from '../src/k8s/utils'

describe('template volumes', () => {
  it('replaces a hook volume with the same name', () => {
    const base = {
      containers: [],
      volumes: [
        { name: 'externals', emptyDir: {} },
        { name: 'work', emptyDir: {} }
      ]
    } as unknown as k8s.V1PodSpec
    const work = {
      name: 'work',
      ephemeral: {
        volumeClaimTemplate: {
          spec: {
            accessModes: ['ReadWriteOnce'],
            storageClassName: 'fast',
            resources: { requests: { storage: '1Gi' } }
          }
        }
      }
    }
    const certs = { name: 'certs', secret: { secretName: 'certs' } }

    mergePodSpecWithOptions(base, {
      containers: [],
      volumes: [work, certs]
    } as unknown as k8s.V1PodSpec)

    expect(base.volumes).toStrictEqual([
      { name: 'externals', emptyDir: {} },
      work,
      certs
    ])
  })
})

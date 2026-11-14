import * as k8s from '@kubernetes/client-node'
import {
  DEFAULT_ORPHAN_MAX_AGE_SECONDS,
  deleteOrphans,
  OrphanApi,
  orphanMaxAgeSeconds,
  orphanRunners,
  podOwnerReference
} from '../src/k8s/orphans'

const now = new Date('2026-11-14T12:00:00Z')

function pod(
  name: string,
  runner: string | undefined,
  ageSeconds: number
): k8s.V1Pod {
  return {
    metadata: {
      name,
      labels: runner ? { 'runner-pod': runner } : {},
      creationTimestamp: new Date(now.getTime() - ageSeconds * 1000)
    }
  }
}

function secret(name: string, runner: string, ageSeconds = 4000): k8s.V1Secret {
  return {
    metadata: {
      name,
      labels: { 'runner-pod': runner },
      creationTimestamp: new Date(now.getTime() - ageSeconds * 1000)
    }
  }
}

describe('orphan age logic', () => {
  const saved = { ...process.env }

  afterEach(() => {
    process.env = { ...saved }
  })

  it('selects runners whose pods are older than the max age', () => {
    const pods = [
      pod('old-workflow', 'old', 3601),
      pod('edge-workflow', 'edge', 3600),
      pod('young-workflow', 'young', 60),
      pod('self-workflow', 'self', 7200),
      pod('nolabel', undefined, 7200)
    ]
    expect(Array.from(orphanRunners(pods, 'self', now, 3600))).toEqual(['old'])
  })

  it('defaults to the runner pod deadline and reads the override', () => {
    delete process.env.ACTIONS_RUNNER_ORPHAN_MAX_AGE_SECONDS
    expect(orphanMaxAgeSeconds()).toBe(DEFAULT_ORPHAN_MAX_AGE_SECONDS)
    expect(DEFAULT_ORPHAN_MAX_AGE_SECONDS).toBe(3600)
    process.env.ACTIONS_RUNNER_ORPHAN_MAX_AGE_SECONDS = '120'
    expect(orphanMaxAgeSeconds()).toBe(120)
    for (const bad of ['0', '-5', '1.5', 'x', '']) {
      process.env.ACTIONS_RUNNER_ORPHAN_MAX_AGE_SECONDS = bad
      expect(orphanMaxAgeSeconds()).toBe(3600)
    }
  })

  it('builds a pod owner reference', () => {
    expect(podOwnerReference({ metadata: { name: 'p', uid: 'u-1' } })).toEqual({
      apiVersion: 'v1',
      kind: 'Pod',
      name: 'p',
      uid: 'u-1'
    })
    expect(() => podOwnerReference({ metadata: { name: 'p' } })).toThrow()
  })
})

describe('deleteOrphans', () => {
  function api(
    pods: k8s.V1Pod[],
    secrets: k8s.V1Secret[]
  ): jest.Mocked<OrphanApi> {
    return {
      listNamespacedPod: jest.fn().mockResolvedValue({ items: pods }),
      deleteNamespacedPod: jest.fn().mockResolvedValue({}),
      listNamespacedSecret: jest.fn().mockResolvedValue({ items: secrets }),
      deleteNamespacedSecret: jest.fn().mockResolvedValue({})
    } as unknown as jest.Mocked<OrphanApi>
  }

  it('deletes only old pods and secrets of an orphaned runner', async () => {
    const a = api(
      [
        pod('old-workflow', 'old', 4000),
        pod('old-step', 'old', 30),
        pod('live-workflow', 'live', 100)
      ],
      [secret('old-secret-1', 'old'), secret('old-secret-new', 'old', 30)]
    )
    const deleted = await deleteOrphans(a, 'ns-jobs', 'self', now, 3600)
    expect(a.listNamespacedPod).toHaveBeenCalledWith({
      namespace: 'ns-jobs',
      labelSelector: 'runner-pod,runner-pod!=self'
    })
    expect(a.listNamespacedSecret).toHaveBeenCalledWith({
      namespace: 'ns-jobs',
      labelSelector: 'runner-pod in (old)'
    })
    expect(deleted).toEqual(['pod/old-workflow', 'secret/old-secret-1'])
    for (const name of ['live-workflow', 'old-step']) {
      expect(a.deleteNamespacedPod).not.toHaveBeenCalledWith(
        expect.objectContaining({ name })
      )
    }
    expect(a.deleteNamespacedSecret).not.toHaveBeenCalledWith(
      expect.objectContaining({ name: 'old-secret-new' })
    )
  })

  it('does nothing when no pod is old enough', async () => {
    const a = api([pod('young', 'young', 10)], [secret('s', 'young')])
    expect(await deleteOrphans(a, 'ns', 'self', now, 3600)).toEqual([])
    expect(a.listNamespacedSecret).not.toHaveBeenCalled()
    expect(a.deleteNamespacedPod).not.toHaveBeenCalled()
  })

  it('ignores objects that another runner deleted first', async () => {
    const a = api([pod('gone', 'old', 4000)], [secret('gone-secret', 'old')])
    a.deleteNamespacedPod.mockRejectedValue({ code: 404 })
    a.deleteNamespacedSecret.mockRejectedValue({ code: 404 })
    expect(await deleteOrphans(a, 'ns', 'self', now, 3600)).toEqual([])
  })
})

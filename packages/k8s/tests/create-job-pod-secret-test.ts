import * as k8s from '@kubernetes/client-node'

describe('job pod pull secret', () => {
  const saved = { ...process.env }
  let createPod: jest.SpyInstance
  let createSecret: jest.SpyInstance

  beforeEach(() => {
    process.env.ACTIONS_RUNNER_POD_NAME = 'runner-abc'
    process.env.ACTIONS_RUNNER_KUBERNETES_NAMESPACE = 'ns-jobs'
    process.env.GITHUB_WORKSPACE = '/__w/repo/repo'
    createPod = jest
      .spyOn(k8s.CoreV1Api.prototype, 'createNamespacedPod')
      .mockImplementation(async ({ body }: any) => ({
        ...body,
        metadata: { ...body.metadata, uid: 'pod-uid-1' }
      }))
    createSecret = jest
      .spyOn(k8s.CoreV1Api.prototype, 'createNamespacedSecret')
      .mockImplementation(async ({ body }: any) => body)
  })

  afterEach(() => {
    jest.restoreAllMocks()
    process.env = { ...saved }
  })

  const registry = {
    username: 'u',
    password: 'p',
    serverUrl: 'https://ghcr.io'
  }
  const container: k8s.V1Container = { name: 'job', image: 'img' }

  it('creates the pull secret after the pod with an owner reference', async () => {
    const { createJobPod } = await import('../src/k8s')
    const created = await createJobPod(
      'runner-abc-workflow',
      container,
      [],
      registry
    )
    const secretName = created.spec?.imagePullSecrets?.[0].name
    expect(secretName).toMatch(/^runner-abc-secret-/)
    expect(createPod.mock.invocationCallOrder[0]).toBeLessThan(
      createSecret.mock.invocationCallOrder[0]
    )
    const body = createSecret.mock.calls[0][0].body as k8s.V1Secret
    expect(body.metadata?.name).toBe(secretName)
    expect(body.metadata?.labels).toEqual({ 'runner-pod': 'runner-abc' })
    expect(body.metadata?.ownerReferences).toEqual([
      {
        apiVersion: 'v1',
        kind: 'Pod',
        name: 'runner-abc-workflow',
        uid: 'pod-uid-1'
      }
    ])
  })

  it('creates no pull secret when the template removes it', async () => {
    const { createJobPod } = await import('../src/k8s')
    await createJobPod('runner-abc-workflow', container, [], registry, {
      spec: { containers: [], imagePullSecrets: [] }
    })
    expect(createPod).toHaveBeenCalledTimes(1)
    expect(createSecret).not.toHaveBeenCalled()
  })

  it('creates no pull secret without a registry', async () => {
    const { createJobPod } = await import('../src/k8s')
    await createJobPod('runner-abc-workflow', container, [])
    expect(createSecret).not.toHaveBeenCalled()
  })
})

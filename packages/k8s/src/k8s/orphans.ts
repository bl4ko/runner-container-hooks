import * as core from '@actions/core'
import * as k8s from '@kubernetes/client-node'

export const RUNNER_POD_LABEL = 'runner-pod'
export const DEFAULT_ORPHAN_MAX_AGE_SECONDS = 3600

export type OrphanApi = Pick<
  k8s.CoreV1Api,
  | 'listNamespacedPod'
  | 'deleteNamespacedPod'
  | 'listNamespacedSecret'
  | 'deleteNamespacedSecret'
>

export function orphanMaxAgeSeconds(): number {
  const value = Number(process.env.ACTIONS_RUNNER_ORPHAN_MAX_AGE_SECONDS)
  return Number.isInteger(value) && value > 0
    ? value
    : DEFAULT_ORPHAN_MAX_AGE_SECONDS
}

export function isOlderThan(
  meta: k8s.V1ObjectMeta | undefined,
  now: Date,
  maxAgeSeconds: number
): boolean {
  const created = meta?.creationTimestamp
  if (!created) {
    return false
  }
  return (now.getTime() - new Date(created).getTime()) / 1000 > maxAgeSeconds
}

export function orphanRunners(
  pods: k8s.V1Pod[],
  self: string,
  now: Date,
  maxAgeSeconds: number
): Set<string> {
  const runners = new Set<string>()
  for (const pod of pods) {
    const runner = pod.metadata?.labels?.[RUNNER_POD_LABEL]
    if (
      runner &&
      runner !== self &&
      isOlderThan(pod.metadata, now, maxAgeSeconds)
    ) {
      runners.add(runner)
    }
  }
  return runners
}

export function podOwnerReference(pod: k8s.V1Pod): k8s.V1OwnerReference {
  if (!pod.metadata?.name || !pod.metadata?.uid) {
    throw new Error('owner pod needs metadata.name and metadata.uid')
  }
  return {
    apiVersion: 'v1',
    kind: 'Pod',
    name: pod.metadata.name,
    uid: pod.metadata.uid
  }
}

function isNotFound(err: unknown): boolean {
  const e = err as { code?: number; statusCode?: number }
  return e?.code === 404 || e?.statusCode === 404
}

export async function deleteOrphans(
  api: OrphanApi,
  namespace: string,
  self: string,
  now: Date,
  maxAgeSeconds: number
): Promise<string[]> {
  const pods = await api.listNamespacedPod({
    namespace,
    labelSelector: `${RUNNER_POD_LABEL},${RUNNER_POD_LABEL}!=${self}`
  })
  const runners = orphanRunners(pods.items, self, now, maxAgeSeconds)
  if (!runners.size) {
    return []
  }
  const selector = `${RUNNER_POD_LABEL} in (${Array.from(runners)
    .sort((a, b) => a.localeCompare(b))
    .join(',')})`
  const secrets = await api.listNamespacedSecret({
    namespace,
    labelSelector: selector
  })
  const deleted: string[] = []
  const remove = async (
    kind: string,
    name: string | undefined,
    call: (name: string) => Promise<unknown>
  ): Promise<void> => {
    if (!name) {
      return
    }
    try {
      await call(name)
      deleted.push(`${kind}/${name}`)
    } catch (err) {
      if (!isNotFound(err)) {
        core.warning(`failed to delete orphaned ${kind} ${name}: ${err}`)
      }
    }
  }
  const old = (meta: k8s.V1ObjectMeta | undefined): boolean =>
    runners.has(meta?.labels?.[RUNNER_POD_LABEL] ?? '') &&
    isOlderThan(meta, now, maxAgeSeconds)
  await Promise.all([
    ...pods.items
      .filter(p => old(p.metadata))
      .map(async p =>
        remove('pod', p.metadata?.name, async name =>
          api.deleteNamespacedPod({ name, namespace })
        )
      ),
    ...secrets.items
      .filter(s => old(s.metadata))
      .map(async s =>
        remove('secret', s.metadata?.name, async name =>
          api.deleteNamespacedSecret({ name, namespace })
        )
      )
  ])
  return deleted.sort((a, b) => a.localeCompare(b))
}

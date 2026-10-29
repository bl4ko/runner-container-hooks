import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RunScriptStepArgs } from 'hooklib'
import { execCpFromPod, execCpToPod, execPodStep } from '../src/k8s'
import { runScriptStep } from '../src/hooks/run-script-step'

jest.mock('../src/k8s', () => ({
  execCpFromPod: jest.fn(),
  execCpToPod: jest.fn(),
  execPodStep: jest.fn()
}))

describe('run script step file commands', () => {
  let base: string
  let runnerTemp: string
  const saved = { ...process.env }

  const args: RunScriptStepArgs = {
    entryPoint: 'node',
    entryPointArgs: ['/__w/_actions/action/dist/index.js'],
    workingDirectory: '/__w/repo/repo'
  }

  function stepFails(): void {
    ;(execPodStep as jest.Mock).mockImplementation(
      async (command: string[]) => {
        if (command[0] === 'sh' && command[1] === '-e') {
          throw new Error('command terminated with exit code 1')
        }
        return 0
      }
    )
  }

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), 'run-script-step-'))
    runnerTemp = path.join(base, '_work', '_temp')
    fs.mkdirSync(runnerTemp, { recursive: true })
    process.env.RUNNER_WORKSPACE = path.join(base, '_work', 'repo')
    process.env.RUNNER_TEMP = runnerTemp
    ;(execCpToPod as jest.Mock).mockResolvedValue(undefined)
    ;(execPodStep as jest.Mock).mockResolvedValue(0)
    ;(execCpFromPod as jest.Mock).mockImplementation(
      async (pod: string, containerPath: string, parent: string) => {
        const dir = path.join(parent, path.basename(containerPath))
        fs.mkdirSync(dir, { recursive: true })
        fs.writeFileSync(path.join(dir, 'save_state_step'), 'isPost=true\n')
      }
    )
  })

  afterEach(() => {
    process.env = { ...saved }
    fs.rmSync(base, { recursive: true, force: true })
  })

  function savedState(): string {
    return fs.readFileSync(
      path.join(runnerTemp, '_runner_file_commands', 'save_state_step'),
      'utf8'
    )
  }

  it('copies the step files back after a successful step', async () => {
    await runScriptStep(args, { jobPod: 'job-pod' })
    expect(savedState()).toBe('isPost=true\n')
  })

  it('copies the step files back after a failed step and keeps the error', async () => {
    stepFails()
    await expect(runScriptStep(args, { jobPod: 'job-pod' })).rejects.toThrow(
      'command terminated with exit code 1'
    )
    expect(execCpFromPod).toHaveBeenCalledWith(
      'job-pod',
      '/__w/_temp/_runner_file_commands',
      path.join(base, '_work', '_temp')
    )
    expect(savedState()).toBe('isPost=true\n')
  })

  it('keeps the step error when the copy back fails', async () => {
    stepFails()
    ;(execCpFromPod as jest.Mock).mockRejectedValue(new Error('pod is gone'))
    await expect(runScriptStep(args, { jobPod: 'job-pod' })).rejects.toThrow(
      'command terminated with exit code 1'
    )
  })
})

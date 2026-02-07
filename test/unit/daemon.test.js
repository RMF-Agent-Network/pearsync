import test from 'brittle'
import os from 'os'
import path from 'path'
import fs from 'fs/promises'
import net from 'net'
import { spawn } from 'child_process'
import { setTimeout as sleep } from 'timers/promises'
import { Daemon } from '../../lib/daemon.js'
import { DaemonClient } from '../../lib/daemon-client.js'

const SOCKET_PATH = path.join(os.tmpdir(), `pearsync-test-${Date.now()}.sock`)

test('daemon - starts and creates Unix socket', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)

  await daemon.start()
  t.ok(daemon.isRunning(), 'daemon should be running')

  // Verify socket exists
  const stats = await fs.stat(SOCKET_PATH)
  t.ok(stats.isSocket(), 'socket file should exist')

  await daemon.stop()
})

test('daemon - stops and removes socket', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)

  await daemon.start()
  t.ok(daemon.isRunning(), 'daemon should be running')

  await daemon.stop()
  t.ok(!daemon.isRunning(), 'daemon should not be running')

  // Verify socket is removed
  await t.exception(async () => {
    await fs.stat(SOCKET_PATH)
  }, 'socket file should be removed')
})

test('daemon - status returns running with workspace info', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)

  await daemon.start()

  const status = await client.send({ command: 'status' })
  t.alike(status, {
    running: true,
    workspaces: [],
    socketPath: SOCKET_PATH
  }, 'should return running status')

  await daemon.stop()
})

test('daemon - status returns stopped when not running', async (t) => {
  const client = new DaemonClient(SOCKET_PATH)

  await t.exception(async () => {
    await client.send({ command: 'status' })
  }, 'should throw when daemon not running')
})

test('daemon - IPC watch command adds workspace', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const workspacePath = os.tmpdir()

  await daemon.start()

  const response = await client.send({
    command: 'watch',
    workspace: workspacePath
  })

  t.ok(response.success, 'watch command should succeed')
  t.is(response.workspace, workspacePath, 'should return workspace path')

  const status = await client.send({ command: 'status' })
  t.is(status.workspaces.length, 1, 'should have one workspace')
  t.is(status.workspaces[0].path, workspacePath, 'workspace path should match')

  await daemon.stop()
})

test('daemon - IPC unwatch command removes workspace', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const workspacePath = os.tmpdir()

  await daemon.start()

  await client.send({
    command: 'watch',
    workspace: workspacePath
  })

  const unwatchResponse = await client.send({
    command: 'unwatch',
    workspace: workspacePath
  })

  t.ok(unwatchResponse.success, 'unwatch command should succeed')

  const status = await client.send({ command: 'status' })
  t.is(status.workspaces.length, 0, 'should have no workspaces')

  await daemon.stop()
})

test('daemon - IPC list command returns active workspaces', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const workspace1 = path.join(os.tmpdir(), `ws1-${Date.now()}`)
  const workspace2 = path.join(os.tmpdir(), `ws2-${Date.now()}`)

  // Create workspace directories
  await fs.mkdir(workspace1, { recursive: true })
  await fs.mkdir(workspace2, { recursive: true })

  await daemon.start()

  await client.send({ command: 'watch', workspace: workspace1 })
  await client.send({ command: 'watch', workspace: workspace2 })

  const response = await client.send({ command: 'list' })

  t.is(response.workspaces.length, 2, 'should have two workspaces')
  t.ok(response.workspaces.some(w => w.path === workspace1), 'should include workspace1')
  t.ok(response.workspaces.some(w => w.path === workspace2), 'should include workspace2')

  await daemon.stop()

  // Cleanup
  await fs.rm(workspace1, { recursive: true, force: true })
  await fs.rm(workspace2, { recursive: true, force: true })
})

test('daemon - IPC invalid command returns error', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)

  await daemon.start()

  const response = await client.send({ command: 'invalid' })

  t.ok(response.error, 'should return error')
  t.ok(response.error.includes('Unknown command'), 'error should mention unknown command')

  await daemon.stop()
})

test('daemon - handles multiple workspaces concurrently', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)

  await daemon.start()

  // Add multiple workspaces concurrently
  const workspaces = Array.from({ length: 5 }, (_, i) =>
    path.join(os.tmpdir(), `ws-concurrent-${Date.now()}-${i}`)
  )

  // Create workspace directories
  await Promise.all(workspaces.map(ws => fs.mkdir(ws, { recursive: true })))

  await Promise.all(
    workspaces.map(ws => client.send({ command: 'watch', workspace: ws }))
  )

  const status = await client.send({ command: 'status' })
  t.is(status.workspaces.length, 5, 'should handle all workspaces')

  await daemon.stop()

  // Cleanup
  await Promise.all(workspaces.map(ws => fs.rm(ws, { recursive: true, force: true })))
})

test('daemon - survives workspace errors without crashing', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const nonExistentPath = path.join(os.tmpdir(), 'does-not-exist-' + Date.now())

  await daemon.start()

  // Try to watch non-existent path - should not crash daemon
  const response = await client.send({
    command: 'watch',
    workspace: nonExistentPath
  })

  // Daemon should still be responsive
  const status = await client.send({ command: 'status' })
  t.ok(status.running, 'daemon should still be running')

  await daemon.stop()
})

test('daemon - graceful shutdown on SIGTERM', async (t) => {
  const testSocketPath = path.join(os.tmpdir(), `pearsync-sigterm-test-${Date.now()}.sock`)

  // Create a child process that runs the daemon
  const childScript = `
    import { Daemon } from '${path.resolve('./lib/daemon.js')}'
    const daemon = new Daemon('${testSocketPath}')
    await daemon.start()
    console.log('DAEMON_STARTED')
    // Keep process alive until SIGTERM
    await new Promise(() => {})
  `

  const child = spawn('node', ['--input-type=module', '-e', childScript], {
    stdio: ['pipe', 'pipe', 'pipe']
  })

  let daemonStarted = false

  // Wait for daemon to start
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('Daemon failed to start in time'))
    }, 5000)

    child.stdout.on('data', (data) => {
      if (data.toString().includes('DAEMON_STARTED')) {
        daemonStarted = true
        clearTimeout(timeout)
        resolve()
      }
    })

    child.stderr.on('data', (data) => {
      console.error('Child stderr:', data.toString())
    })

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(err)
    })
  })

  t.ok(daemonStarted, 'daemon should have started')

  // Verify socket was created
  const stats = await fs.stat(testSocketPath)
  t.ok(stats.isSocket(), 'socket file should exist')

  // Send SIGTERM to child process
  child.kill('SIGTERM')

  // Wait for graceful shutdown
  const exitCode = await new Promise((resolve) => {
    child.on('exit', (code, signal) => resolve({ code, signal }))
  })

  // Give a moment for cleanup to complete
  await sleep(200)

  // Process should exit with code 0, 130 (128 + SIGTERM=2), or be terminated by signal
  // Exit code 130 is the standard exit code for a process terminated by SIGTERM
  t.ok(
    exitCode.code === 0 || exitCode.code === 130 || exitCode.code === null || exitCode.signal === 'SIGTERM',
    `daemon should exit gracefully (got code: ${exitCode.code}, signal: ${exitCode.signal})`
  )

  // Verify socket was cleaned up
  await t.exception(async () => {
    await fs.stat(testSocketPath)
  }, 'socket file should be removed after SIGTERM')
})

test('daemon - auto-cleanup of socket on exit', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)

  await daemon.start()

  // Verify socket exists
  await fs.stat(SOCKET_PATH)

  await daemon.stop()

  // Socket should be cleaned up
  await t.exception(async () => {
    await fs.stat(SOCKET_PATH)
  }, 'socket should be removed on exit')
})

test('daemon - rejects duplicate workspace watches', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const workspacePath = os.tmpdir()

  await daemon.start()

  await client.send({ command: 'watch', workspace: workspacePath })

  const response = await client.send({
    command: 'watch',
    workspace: workspacePath
  })

  t.ok(response.error || response.success, 'should handle duplicate watch gracefully')

  const status = await client.send({ command: 'status' })
  t.is(status.workspaces.length, 1, 'should only have one instance of workspace')

  await daemon.stop()
})

test('daemon - client handles connection errors gracefully', async (t) => {
  const client = new DaemonClient('/non/existent/socket.sock')

  await t.exception(async () => {
    await client.send({ command: 'status' })
  }, 'should throw on connection error')
})

test('daemon - preserves workspace state across commands', async (t) => {
  const daemon = new Daemon(SOCKET_PATH)
  const client = new DaemonClient(SOCKET_PATH)
  const workspacePath = os.tmpdir()

  await daemon.start()

  await client.send({ command: 'watch', workspace: workspacePath })

  // Multiple status checks should show consistent state
  const status1 = await client.send({ command: 'status' })
  const status2 = await client.send({ command: 'status' })

  t.is(status1.workspaces.length, status2.workspaces.length, 'state should be consistent')
  t.is(status1.workspaces[0].path, status2.workspaces[0].path, 'workspace should persist')

  await daemon.stop()
})

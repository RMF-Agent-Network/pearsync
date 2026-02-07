import test from 'brittle'
import { FSWatcher } from '../../lib/fs-watcher.js'
import tmp from 'tmp-promise'
import fs from 'fs/promises'
import path from 'path'

const tmpdir = tmp.dir

test('detect file creation', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const watcher = new FSWatcher(dir)

  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello')

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should emit one event')
  t.is(events[0].type, 'add', 'should be add event')
  t.is(events[0].path, 'test.txt', 'should have correct path')

  await watcher.close()
  await cleanup()
})

test('detect file modification', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello')

  const watcher = new FSWatcher(dir)
  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  await fs.writeFile(testFile, 'world')

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should emit one event')
  t.is(events[0].type, 'change', 'should be change event')
  t.is(events[0].path, 'test.txt', 'should have correct path')

  await watcher.close()
  await cleanup()
})

test('detect file deletion', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })

  const testFile = path.join(dir, 'test.txt')
  await fs.writeFile(testFile, 'hello')

  const watcher = new FSWatcher(dir)
  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  await fs.unlink(testFile)

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should emit one event')
  t.is(events[0].type, 'unlink', 'should be unlink event')
  t.is(events[0].path, 'test.txt', 'should have correct path')

  await watcher.close()
  await cleanup()
})

test('detect directory creation', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const watcher = new FSWatcher(dir)

  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  const testDir = path.join(dir, 'subdir')
  await fs.mkdir(testDir)

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should emit one event')
  t.is(events[0].type, 'addDir', 'should be addDir event')
  t.is(events[0].path, 'subdir', 'should have correct path')

  await watcher.close()
  await cleanup()
})

test('detect directory deletion', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })

  const testDir = path.join(dir, 'subdir')
  await fs.mkdir(testDir)

  const watcher = new FSWatcher(dir)
  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  await fs.rmdir(testDir)

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should emit one event')
  t.is(events[0].type, 'unlinkDir', 'should be unlinkDir event')
  t.is(events[0].path, 'subdir', 'should have correct path')

  await watcher.close()
  await cleanup()
})

test('debounce rapid changes', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const watcher = new FSWatcher(dir)

  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  const testFile = path.join(dir, 'test.txt')

  // Rapid writes
  await fs.writeFile(testFile, 'v1')
  await fs.writeFile(testFile, 'v2')
  await fs.writeFile(testFile, 'v3')

  await new Promise(resolve => setTimeout(resolve, 500))

  t.ok(events.length >= 1, 'should emit at least one event')
  t.ok(events.length <= 2, 'should debounce multiple rapid changes')

  await watcher.close()
  await cleanup()
})

test('respect .pearsyncignore patterns', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })

  await fs.writeFile(path.join(dir, '.pearsyncignore'), '*.log\nnode_modules/')

  const watcher = new FSWatcher(dir)
  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  await fs.writeFile(path.join(dir, 'test.log'), 'ignored')
  await fs.writeFile(path.join(dir, 'test.txt'), 'not ignored')

  await new Promise(resolve => setTimeout(resolve, 300))

  t.is(events.length, 1, 'should only emit event for non-ignored file')
  t.is(events[0].path, 'test.txt', 'should only track non-ignored file')

  await watcher.close()
  await cleanup()
})

test('handle atomic writes (temp file pattern)', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const watcher = new FSWatcher(dir)

  const events = []
  watcher.on('change', (event) => events.push(event))

  await watcher.ready()

  const testFile = path.join(dir, 'test.txt')
  const tempFile = path.join(dir, '.test.txt.tmp')

  // Simulate atomic write: write to temp, then rename
  await fs.writeFile(tempFile, 'hello')
  await fs.rename(tempFile, testFile)

  await new Promise(resolve => setTimeout(resolve, 300))

  t.ok(events.some(e => e.path === 'test.txt'), 'should detect final file')

  await watcher.close()
  await cleanup()
})

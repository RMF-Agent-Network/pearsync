import test from 'brittle'
import { IgnoreParser } from '../../lib/ignore.js'
import tmp from 'tmp-promise'
import fs from 'fs/promises'
import path from 'path'

const tmpdir = tmp.dir

test('parse .pearsyncignore file', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, '*.log\nnode_modules/\n.DS_Store')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('test.log'), 'should ignore .log files')
  t.ok(parser.ignores('node_modules/package.json'), 'should ignore node_modules')
  t.ok(parser.ignores('.DS_Store'), 'should ignore .DS_Store')
  t.is(parser.ignores('test.txt'), false, 'should not ignore .txt files')

  await cleanup()
})

test('default patterns', async (t) => {
  const parser = new IgnoreParser()
  await parser.load()

  t.ok(parser.ignores('.git/config'), 'should ignore .git by default')
  t.ok(parser.ignores('node_modules/foo'), 'should ignore node_modules by default')
  t.ok(parser.ignores('.DS_Store'), 'should ignore .DS_Store by default')
  t.is(parser.ignores('src/index.js'), false, 'should not ignore regular files')
})

test('match exact filenames', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, '.DS_Store\nThumbs.db')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('.DS_Store'), 'should ignore exact filename')
  t.ok(parser.ignores('subdir/.DS_Store'), 'should ignore exact filename in subdirs')
  t.ok(parser.ignores('Thumbs.db'), 'should ignore another exact filename')
  t.is(parser.ignores('.DS_Store.txt'), false, 'should not match partial names')

  await cleanup()
})

test('match directory patterns', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, 'build/\ntmp/')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('build/'), 'should ignore directory')
  t.ok(parser.ignores('build/index.js'), 'should ignore files in directory')
  t.ok(parser.ignores('build/nested/file.js'), 'should ignore nested files')
  t.ok(parser.ignores('tmp/cache.json'), 'should ignore files in tmp')
  t.is(parser.ignores('src/build.js'), false, 'should not match build as part of path')

  await cleanup()
})

test('match glob patterns', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, '*.log\n*.tmp\ntest-*.js')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('error.log'), 'should match *.log')
  t.ok(parser.ignores('debug.log'), 'should match *.log')
  t.ok(parser.ignores('cache.tmp'), 'should match *.tmp')
  t.ok(parser.ignores('test-utils.js'), 'should match test-*.js')
  t.is(parser.ignores('test.js'), false, 'should not match test.js')
  t.is(parser.ignores('app.js'), false, 'should not match app.js')

  await cleanup()
})

test('negation patterns (!pattern)', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, '*.log\n!important.log')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('error.log'), 'should ignore .log files')
  t.ok(parser.ignores('debug.log'), 'should ignore .log files')
  t.is(parser.ignores('important.log'), false, 'should not ignore negated file')

  await cleanup()
})

test('comments and blank lines ignored', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, `# This is a comment
*.log

# Another comment
*.tmp

# Blank lines above and below`)

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('test.log'), 'should ignore .log')
  t.ok(parser.ignores('test.tmp'), 'should ignore .tmp')
  t.is(parser.ignores('# This is a comment'), false, 'should not treat comments as patterns')

  await cleanup()
})

test('relative paths', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, 'src/generated/\ndocs/*.pdf')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('src/generated/file.js'), 'should ignore relative directory')
  t.ok(parser.ignores('docs/manual.pdf'), 'should ignore with relative glob')
  t.is(parser.ignores('other/generated/file.js'), false, 'should not match wrong path')

  await cleanup()
})

test('case sensitivity', async (t) => {
  const { path: dir, cleanup } = await tmpdir({ unsafeCleanup: true })
  const ignoreFile = path.join(dir, '.pearsyncignore')

  await fs.writeFile(ignoreFile, 'README.md')

  const parser = new IgnoreParser(ignoreFile)
  await parser.load()

  t.ok(parser.ignores('README.md'), 'should match exact case')
  // Note: ignore library is case-sensitive by default
  // This behavior matches gitignore
  t.ok(parser.ignores('readme.md'), 'ignore library treats patterns as case-insensitive by default')

  await cleanup()
})

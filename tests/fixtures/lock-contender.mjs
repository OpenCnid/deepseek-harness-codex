import { writeFile } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

const [filename, marker] = process.argv.slice(2)
if (typeof filename !== 'string' || typeof marker !== 'string') process.exitCode = 2
else {
  process.stdout.write('attempting\n')
  await withFileLock(filename, async () => {
    await writeFile(marker, 'entered', { encoding: 'utf8', flag: 'wx', mode: 0o600 })
  })
}

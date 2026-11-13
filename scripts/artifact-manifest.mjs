// 검증된 OS별 산출물의 SHA-256과 소스 커밋. 업로드·공개는 하지 않는다.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { createReadStream, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'

export async function artifactManifest(dir, { version, platform, arch, source }) {
  if (!/^[a-f0-9]{40}$/i.test(source ?? '')) throw new Error('전체 소스 커밋 SHA가 필요합니다')
  const names = readdirSync(dir).filter((name) => /\.(?:dmg|zip|exe|AppImage|deb|blockmap)$/.test(name) || /^latest.*\.ya?ml$/.test(name)).sort()
  if (!names.length) throw new Error(`배포 산출물이 없음: ${dir}`)
  if (names.some((name) => !/^latest.*\.ya?ml$/.test(name) && !name.startsWith(`Taskminal-${version}-`))) throw new Error(`다른 버전 또는 알 수 없는 배포 파일이 포함됨: ${version}`)
  const files = []
  for (const name of names) {
    const hash = createHash('sha256')
    let size = 0
    for await (const chunk of createReadStream(join(dir, name))) { hash.update(chunk); size += chunk.length }
    files.push({ name, size, sha256: hash.digest('hex') })
  }
  const manifest = { version, source, platform, arch, files }
  const suffix = `${platform}-${arch}`
  writeFileSync(join(dir, `manifest-${suffix}.json`), `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(join(dir, `SHA256SUMS-${suffix}`), files.map((f) => `${f.sha256}  ${f.name}\n`).join(''))
  return manifest
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const dir = process.argv[2]
  if (!dir) throw new Error('사용법: node scripts/artifact-manifest.mjs <output dir> [platform] [arch]')
  const version = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const result = await artifactManifest(dir, { version, source, platform: process.argv[3] ?? process.platform, arch: process.argv[4] ?? process.arch })
  console.log(`${basename(dir)}: ${result.files.length}개 파일 해시 기록`)
}

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { expect, test } from 'vitest'

// 57단계: `~` 를 홈으로 푸는 규칙은 src/shared/cwd.ts 의 expandHome 하나다.
// 손으로 쓴 펼치기가 main · renderer 에 11벌 퍼져 `~//x` 같은 경로에서 서로 다르게 풀었고,
// 모을 때 'src/main 만' 검색해 renderer 한 벌을 놓쳤다 — 그래서 src 전체를 본다.
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? sources(path) : /\.(ts|tsx)$/.test(name) ? [path] : []
  })
const STARTS_WITH_TILDE = /startsWith\(\s*['"`]~\/['"`]\s*\)/
// 같은 줄에서 `~/` 를 떼어(slice) 홈(이름에 home 이 든 값 · homedir())에 붙이는 꼴 — 변수 이름에 기대지 않게 넓게.
// 한 줄 검사라 여러 줄로 나눠 쓴 펼치기는 못 본다 — 57 전 11벌은 모두 한 줄이었고 이 식이 11벌을 다 찾는다
const SLICES_TILDE = /\.slice\([12]\)/
const USES_HOME = /home/i

test('`~` 를 홈으로 푸는 곳은 공용 expandHome 하나뿐이다 (손으로 쓴 펼치기 없음)', () => {
  const handWritten = sources('src')
    .filter((file) => !file.endsWith(join('shared', 'cwd.ts')))
    .flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) => (STARTS_WITH_TILDE.test(line) && SLICES_TILDE.test(line) && USES_HOME.test(line) ? [`${relative('.', file)}:${i + 1}`] : [])),
    )
  expect(handWritten).toEqual([])
})

export interface PrLink { url: string; repository: string; number: number }
export interface PrDependency {
  url: string
  title: string
  state: 'open' | 'merged' | 'closed' | 'unknown'
  checks: import('./git-workflow').PullRequestView['checks']
}

export function parsePrLinks(value: unknown): PrLink[] {
  if (!Array.isArray(value) || value.length > 8) throw new Error('순서대로 GitHub PR 주소를 최대 8개까지 입력해 주세요.')
  const seen = new Set<string>()
  return value.map(url => {
    const match = typeof url === 'string' && url.length <= 300 ? /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)$/i.exec(url) : null
    const number = Number(match?.[2])
    if (!match || !Number.isSafeInteger(number)) throw new Error('GitHub PR 주소를 확인해 주세요.')
    const repository = match[1]!
    const canonical = `https://github.com/${repository}/pull/${number}`
    if (seen.has(canonical.toLowerCase())) throw new Error('같은 PR을 한 번만 입력해 주세요.')
    seen.add(canonical.toLowerCase())
    return { url: canonical, repository, number }
  })
}

export function dependencyOrder(rows: readonly PrDependency[]): Array<PrDependency & { blockedBy: string | null }> {
  let blocker: string | null = null
  return rows.map(row => {
    const result = { ...row, blockedBy: blocker }
    if (!blocker && (row.state !== 'merged' || row.checks !== 'passed')) blocker = row.url
    return result
  })
}

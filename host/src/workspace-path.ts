export const maxPathLength = 512
const forbiddenName = /^(?:node_modules|(?:credentials?|secrets?)(?:\.(?:jsonc?|ya?ml|toml|ini|cfg|conf|txt|xml|env)|$)|auth\.(?:jsonc?|ya?ml|toml|ini|cfg|conf|env)$|id_(?:rsa|dsa|ecdsa|ed25519|ecdsa_sk|ed25519_sk)(?:\.|$))/iu
const allowedDotDirectory = /^(?:\.github|\.changeset|\.storybook|\.well-known)$/iu
const readOnlyDotDirectory = /^(?:\.pi|\.agents|\.claude|\.codex)$/iu
const allowedDotFile = /^(?:\.(?:gitignore|gitkeep|dockerignore|npmignore|eslintignore|prettierignore|stylelintignore|vercelignore|cfignore|editorconfig|nvmrc|node-version|python-version|ruby-version|tool-versions|browserslistrc|swcrc|yamllint)|\.env\.(?:example|sample|template)|\.npmrc\.(?:example|sample|template)|\.(?:prettierrc|eslintrc|stylelintrc|babelrc|lintstagedrc)(?:\.(?:json5?|ya?ml|toml|[cm]?js))?|\.(?:markdownlint|commitlintrc)\.(?:jsonc?|ya?ml)|\.yamllint\.ya?ml)$/iu
const reservedName = /^(?:con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[0-9¹²³])(?: *\.|$)/iu
const sensitiveExtension = /\.(?:key|pem|pfx|p12|ppk|sqlite|db)(?:[-.]|$)/iu
const invalidPathCharacter = /[\u0000-\u001f\u007f<>:"|?*]/u

export class WorkspaceDenied extends Error {}

export function workspaceTarget(input: unknown, mode: 'read' | 'write' = 'write'): string | undefined {
  if (!input || typeof input !== 'object' || !('path' in input)) return undefined
  try {
    return segments(input.path, false, 'any', mode).join('/')
  } catch {
    return undefined
  }
}

function allowedDotSegment(name: string, kind: 'file' | 'directory' | 'any', mode: 'read' | 'write' = 'write'): boolean {
  if (kind === 'directory') return allowedDotDirectory.test(name) || (mode === 'read' && readOnlyDotDirectory.test(name))
  if (kind === 'file') return allowedDotFile.test(name)
  return allowedDotDirectory.test(name) || allowedDotFile.test(name) || (mode === 'read' && readOnlyDotDirectory.test(name))
}

export function allowedSegment(name: string, kind: 'file' | 'directory' | 'any' = 'any', mode: 'read' | 'write' = 'write'): boolean {
  if (name.length === 0 || name === '.' || name === '..' || /[ .]$/u.test(name)) return false
  if (name.startsWith('.') && !allowedDotSegment(name, kind, mode)) return false
  return !invalidPathCharacter.test(name) && !forbiddenName.test(name) &&
    !reservedName.test(name) && !sensitiveExtension.test(name)
}

export function withinScopePath(scope: string | undefined, target: string): boolean {
  if (scope === undefined) return true
  if (process.platform === 'win32') {
    scope = scope.toLowerCase()
    target = target.toLowerCase()
  }
  return target === scope || target.startsWith(scope + '/')
}

export function segments(value: unknown, allowRoot = false, leafKind: 'file' | 'directory' | 'any' = allowRoot ? 'directory' : 'any',
  mode: 'read' | 'write' = 'write'): string[] {
  if (allowRoot && value === '.') return []
  if (typeof value !== 'string' || value.length > maxPathLength) throw new WorkspaceDenied('Invalid relative path')
  const parts = value.split(/[\\/]/u)
  if (!parts.every((part, index) => allowedSegment(part, index < parts.length - 1 ? 'directory' : leafKind, mode))) {
    throw new WorkspaceDenied('Path denied by workspace policy')
  }
  return parts
}

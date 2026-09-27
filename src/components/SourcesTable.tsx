import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import type { SourceLedgerEntry } from '../../electron/core/octa/sources'

export interface SourcesTableProps {
  sources: readonly SourceLedgerEntry[]
  locale: Locale
  maxRows?: number
}
function label(key: TranslationKey, locale: Locale): string {
  return t(key, locale)
}

/** Compact, read-only ledger viewer shared by the Jobs page and research output. */
export function SourcesTable({ sources, locale, maxRows = 200 }: SourcesTableProps): React.JSX.Element {
  const visible = sources.slice(0, Math.max(1, maxRows))
  return (
    <section className="sources-card glass" aria-label={label('sourcesLedger', locale)}>
      <header className="sources-heading">
        <div>
          <span className="job-card-eyebrow">{label('sourcesLedger', locale)}</span>
          <h2>{sources.length} <span className="sources-count">{label('sourcesRead', locale)}</span></h2>
        </div>
      </header>
      {visible.length === 0 ? (
        <p className="empty-state">{label('noSources', locale)}</p>
      ) : (
        <div className="sources-table-wrap">
          <table className="sources-table">
            <thead>
              <tr>
                <th>{label('sourceNumber', locale)}</th>
                <th>{label('sourceTitle', locale)}</th>
                <th>{label('sourceLanguage', locale)}</th>
                <th>{label('sourceType', locale)}</th>
                <th>{label('sourceDate', locale)}</th>
                <th>{label('sourceRelevance', locale)}</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((source) => (
                <tr key={`${source.n}-${source.url}`}>
                  <td className="source-number">{source.n}</td>
                  <td className="source-title">
                    <a href={source.url} rel="noreferrer" target="_blank">{source.title || source.url}</a>
                    <small>{source.domain}</small>
                  </td>
                  <td>{source.lang}</td>
                  <td>{source.type}</td>
                  <td>{source.published || source.fetched.slice(0, 10)}</td>
                  <td>{Number.isFinite(source.relevance) ? source.relevance.toFixed(2) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {sources.length > visible.length && <p className="sources-more">+ {sources.length - visible.length}</p>}
    </section>
  )
}

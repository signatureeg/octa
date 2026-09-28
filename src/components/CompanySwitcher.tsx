import { useEffect, useState } from 'react'
import { Building2 } from 'lucide-react'
import type { CompanyInfo } from '../../electron/core/octa/companies'
import type { Locale } from '../i18n'
import { t } from '../i18n'

/** Which company Octa and its agents work for right now (knowledge/companies/<slug>). */
export function CompanySwitcher({ locale }: { locale: Locale }): React.JSX.Element | null {
  const [state, setState] = useState<{ companies: CompanyInfo[]; active: string } | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!window.octa?.companies) return
    void window.octa.companies.list().then(setState).catch(() => setState(null))
    return window.octa.companies.onChanged?.(setState)
  }, [])

  if (!Array.isArray(state?.companies) || state.companies.length === 0) return null
  return (
    <label className="company-switcher" title={error || t('companyActive', locale)}>
      <Building2 size={15} aria-hidden="true" />
      <span className="sr-only">{t('companyActive', locale)}</span>
      <select
        aria-label={t('companyActive', locale)}
        onChange={(event) => {
          setError('')
          void window.octa.companies.setActive(event.target.value).then(setState).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
        }}
        value={state.active}
      >
        {state.companies.map((company) => <option key={company.slug} value={company.slug}>{company.name}</option>)}
      </select>
    </label>
  )
}

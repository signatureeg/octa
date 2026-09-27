import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  FileSignature,
  FileText,
  Palette,
  Plus,
  ReceiptText,
  Trash2,
  UserPlus,
  Users
} from 'lucide-react'
import type {
  ClientRecord,
  DocumentBrand,
  DocumentKind,
  DocumentRecord,
  InvoiceRecord
} from '../../electron/types'
import type { Locale, TranslationKey } from '../i18n'
import { t } from '../i18n'
import { BrandEditor } from './BrandEditor'
import { DocumentEditor } from './DocumentEditor'

const KINDS: Array<{ kind: DocumentKind; label: TranslationKey; newLabel: TranslationKey; icon: typeof FileText }> = [
  { kind: 'proposal', label: 'clientsProposals', newLabel: 'clientsNewProposal', icon: FileText },
  { kind: 'contract', label: 'clientsContracts', newLabel: 'clientsNewContract', icon: FileSignature },
  { kind: 'invoice', label: 'clientsInvoices', newLabel: 'clientsNewInvoice', icon: ReceiptText }
]

function intlLocale(locale: Locale): string {
  return locale === 'ar' ? 'ar-EG' : 'en-US'
}

function label(key: TranslationKey, locale: Locale): string {
  return t(key, locale)
}

function interpolate(value: string, replacements: Record<string, string>): string {
  return Object.entries(replacements).reduce(
    (result, [key, replacement]) => result.replaceAll(`{${key}}`, replacement),
    value
  )
}

function currency(minor: number, code: string, locale: Locale = 'en'): string {
  return new Intl.NumberFormat(intlLocale(locale), { style: 'currency', currency: code }).format(minor / 100)
}

function invoiceStatusKey(status: InvoiceRecord['status']): TranslationKey {
  return status === 'draft'
    ? 'invoiceStatusDraft'
    : status === 'sent'
      ? 'invoiceStatusSent'
      : status === 'paid'
        ? 'invoiceStatusPaid'
        : 'invoiceStatusOverdue'
}

/** Blank starting content per document type, so a new draft is never an empty page. */
function starterFields(kind: DocumentKind, client: ClientRecord, reference: string, locale: Locale): Record<string, unknown> {
  if (kind === 'contract') {
    return {
      reference,
      clientName: client.name,
      clientDetails: client.email || '',
      projectName: '',
      subject: '',
      scopeIn: label('documentStarterContractScopeIn', locale),
      scopeOut: label('documentStarterContractScopeOut', locale),
      phases: [
        {
          title: label('documentStarterPhaseRequirements', locale),
          detail: label('documentStarterPhaseRequirementsDetail', locale)
        },
        {
          title: label('documentStarterPhaseDesign', locale),
          detail: label('documentStarterPhaseDesignDetail', locale)
        },
        {
          title: label('documentStarterPhaseDevelopment', locale),
          detail: label('documentStarterPhaseDevelopmentDetail', locale)
        },
        {
          title: label('documentStarterPhaseDelivery', locale),
          detail: label('documentStarterPhaseDeliveryDetail', locale)
        }
      ],
      amountMinor: 0,
      currency: 'EGP',
      paymentTerms: label('documentStarterPaymentTerms', locale),
      revisions: label('documentStarterRevisions', locale),
      deliverables: label('documentStarterDeliverables', locale),
      startAt: Date.now(),
      durationDays: 30
    }
  }
  return {
    reference,
    clientName: client.name,
    title: '',
    titleAccent: '',
    understanding: '',
    objectives: [
      { title: '', detail: '' },
      { title: '', detail: '' }
    ],
    scope: [{ title: label('documentStarterScope', locale), items: '' }],
    plan: [
      { title: label('documentStarterPlanAnalysis', locale), detail: '' },
      { title: label('documentStarterPlanDesign', locale), detail: '' },
      { title: label('documentStarterPlanDevelopment', locale), detail: '' },
      { title: label('documentStarterPlanDelivery', locale), detail: '' }
    ],
    clientNeeds: '',
    includes: '',
    excludes: '',
    amountMinor: 0,
    currency: 'EGP',
    durationDays: 30,
    nextStep: label('documentStarterNextStep', locale)
  }
}
export function ClientsPage({ onBack, locale }: { onBack: () => void; locale: Locale }): React.JSX.Element {
  const [clients, setClients] = useState<ClientRecord[]>([])
  const [invoices, setInvoices] = useState<InvoiceRecord[]>([])
  const [documents, setDocuments] = useState<DocumentRecord[]>([])
  const [brands, setBrands] = useState<DocumentBrand[]>([])
  const [selected, setSelected] = useState<string>()
  const [tab, setTab] = useState<DocumentKind>('proposal')
  const [editing, setEditing] = useState<DocumentRecord>()
  const [brandPanel, setBrandPanel] = useState(false)
  const [newClient, setNewClient] = useState('')
  const [error, setError] = useState('')
  const firstLoad = useRef(true)

  const load = useCallback(async () => {
    const [nextClients, nextInvoices, nextDocuments, nextBrands] = await Promise.all([
      window.octa.billing.clients(),
      window.octa.billing.invoices(),
      window.octa.documents.list(),
      window.octa.brands.list()
    ])
    setClients(nextClients)
    setInvoices(nextInvoices)
    setDocuments(nextDocuments)
    setBrands(nextBrands)
    if (firstLoad.current && nextClients[0]) {
      setSelected(nextClients[0].id)
      firstLoad.current = false
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (action: Promise<unknown>): Promise<void> => {
    try {
      setError('')
      await action
      await load()
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    }
  }

  const client = clients.find((entry) => entry.id === selected)
  const clientInvoices = useMemo(
    () => invoices.filter((invoice) => invoice.clientId === selected),
    [invoices, selected]
  )
  const clientDocuments = useMemo(
    () => documents.filter((doc) => doc.clientId === selected && doc.kind === tab),
    [documents, selected, tab]
  )

  const createDocument = async (): Promise<void> => {
    if (!client) return
    const reference = await window.octa.documents.nextReference(tab)
    const brand = brands.find((entry) => entry.isDefault) ?? brands[0]
    const record: DocumentRecord = {
      id: '',
      kind: tab,
      clientId: client.id,
      clientName: client.name,
      brandId: brand?.id ?? '',
      reference,
      title: tab === 'contract' ? label('documentNewContract', locale) : label('documentNewProposal', locale),
      fields: starterFields(tab, client, reference, locale),
      overrides: {},
      createdAt: 0,
      updatedAt: 0,
      pdfPath: null
    }
    const saved = await window.octa.documents.save(record)
    await load()
    setEditing(saved)
  }

  if (editing) {
    return (
      <DocumentEditor
        record={editing}
        brands={brands}
        locale={locale}
        onClose={() => {
          setEditing(undefined)
          void load()
        }}
      />
    )
  }

  return (
    <div className="page" dir={locale === 'ar' ? 'rtl' : 'ltr'}>
      <header className="compact-heading">
        <div>
          <span className="eyebrow">{label('clientsEyebrow', locale)}</span>
          <h1>{label('clientsTitle', locale)}</h1>
        </div>
        <div className="heading-actions">
          <button className="text-button" onClick={() => setBrandPanel(!brandPanel)} type="button">
            <Palette size={15} aria-hidden="true" /> {label('clientsBrands', locale)}
          </button>
          <button className="text-button" onClick={onBack} type="button">
            <ArrowLeft size={15} aria-hidden="true" /> {label('clientsBack', locale)}
          </button>
        </div>
      </header>

      {error && <p className="inline-error">{error}</p>}

      {brandPanel && (
        <BrandEditor
          brands={brands}
          locale={locale}
          onSaved={(next) => setBrands(next)}
          onClose={() => setBrandPanel(false)}
        />
      )}

      <div className="clients-layout">
        <aside className="clients-list glass">
          <div className="section-title">
            <h3>
              <Users size={15} aria-hidden="true" /> {label('clientsListTitle', locale)}
            </h3>
            <span className="count-chip">{clients.length}</span>
          </div>
          <div className="clients-scroll">
            {clients.map((entry) => (
              <button
                key={entry.id}
                className={entry.id === selected ? 'active' : ''}
                onClick={() => setSelected(entry.id)}
                type="button"
              >
                <strong dir="auto">{entry.name}</strong>
                <span>{entry.email || '—'}</span>
              </button>
            ))}
            {clients.length === 0 && <p className="task-column-empty">{label('clientsNoClients', locale)}</p>}
          </div>
          <div className="clients-add">
            <input
              value={newClient}
              onChange={(event) => setNewClient(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !newClient.trim()) return
                void run(window.octa.billing.saveClient({ name: newClient.trim() }))
                setNewClient('')
              }}
              placeholder={label('clientsNewPlaceholder', locale)}
              dir="auto"
            />
            <button
              className="secondary-button"
              disabled={!newClient.trim()}
              onClick={() => {
                void run(window.octa.billing.saveClient({ name: newClient.trim() }))
                setNewClient('')
              }}
              aria-label={label('clientsNewPlaceholder', locale)}
              type="button"
            >
              <UserPlus size={14} aria-hidden="true" />
            </button>
          </div>
        </aside>

        <section className="clients-detail">
          {!client ? (
            <div className="glass empty-state">
              <Users size={26} aria-hidden="true" />
              <h3>{label('clientsPickTitle', locale)}</h3>
              <p>{label('clientsPickDetail', locale)}</p>
            </div>
          ) : (
            <>
              <header className="client-head glass">
                <div>
                  <h2 dir="auto">{client.name}</h2>
                  <span>{client.email || label('clientsNoEmail', locale)}</span>
                </div>
                <button
                  className="text-button danger"
                  type="button"
                  onClick={() => {
                    if (window.confirm(interpolate(label('clientsDeleteConfirm', locale), { name: client.name }))) {
                      void run(window.octa.billing.deleteClient(client.id))
                      setSelected(undefined)
                    }
                  }}
                >
                  <Trash2 size={14} aria-hidden="true" /> {label('clientsDelete', locale)}
                </button>
              </header>

              <div className="mode-picker doc-tabs" role="radiogroup" aria-label={label('clientsDocumentType', locale)}>
                {KINDS.map(({ kind, label: kindLabel, icon: Icon }) => (
                  <button
                    key={kind}
                    className={tab === kind ? 'active' : ''}
                    role="radio"
                    aria-checked={tab === kind}
                    onClick={() => setTab(kind)}
                    type="button"
                  >
                    <Icon size={14} aria-hidden="true" /> {label(kindLabel, locale)}
                  </button>
                ))}
              </div>

              {tab === 'invoice' ? (
                <section className="glass doc-list">
                  {clientInvoices.length === 0 && (
                    <p className="task-column-empty">{label('clientsNoInvoices', locale)}</p>
                  )}
                  {clientInvoices.map((invoice) => (
                    <article key={invoice.id}>
                      <div>
                        <strong>{invoice.number}</strong>
                        <span>{currency(invoice.total, invoice.currency, locale)}</span>
                      </div>
                      <span className={`status-pill ${invoice.status}`}>{label(invoiceStatusKey(invoice.status), locale)}</span>
                      <div className="doc-actions">
                        {invoice.storedStatus !== 'sent' && invoice.storedStatus !== 'paid' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              void run(window.octa.billing.setStatus(invoice.id, 'sent'))
                            }
                            type="button"
                          >
                            {label('clientsMarkSent', locale)}
                          </button>
                        )}
                        {invoice.storedStatus !== 'paid' && (
                          <button
                            className="text-button"
                            onClick={() =>
                              void run(window.octa.billing.setStatus(invoice.id, 'paid'))
                            }
                            type="button"
                          >
                            <Check size={13} aria-hidden="true" /> {label('clientsMarkPaid', locale)}
                          </button>
                        )}
                        <button
                          className="text-button"
                          onClick={async () => {
                            const path = await window.octa.billing.pdf(invoice.id)
                            await window.octa.billing.openPdf(path)
                          }}
                          type="button"
                        >
                          {label('clientsOpenPdf', locale)}
                        </button>
                        <button
                          className="text-button danger"
                          aria-label={label('clientsDelete', locale)}
                          type="button"
                          onClick={() => {
                            if (window.confirm(interpolate(label('clientsDeleteInvoiceConfirm', locale), { number: invoice.number }))) {
                              void run(window.octa.billing.deleteInvoice(invoice.id))
                            }
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              ) : (
                <section className="glass doc-list">
                  <div className="doc-list-head">
                    <button className="primary-button compact" onClick={() => void createDocument()} type="button">
                      <Plus size={13} aria-hidden="true" /> {label(KINDS.find((entry) => entry.kind === tab)?.newLabel ?? 'clientsNewProposal', locale)}
                    </button>
                  </div>
                  {clientDocuments.length === 0 && (
                    <p className="task-column-empty">{label('clientsNothingHere', locale)}</p>
                  )}
                  {clientDocuments.map((doc) => (
                    <article key={doc.id}>
                      <div>
                        <strong dir="auto">{doc.title || doc.reference}</strong>
                        <span>{doc.reference}</span>
                      </div>
                      <span className="doc-date">
                        {new Date(doc.updatedAt).toLocaleDateString(intlLocale(locale))}
                      </span>
                      <div className="doc-actions">
                        <button className="text-button" onClick={() => setEditing(doc)} type="button">
                          {label('clientsOpen', locale)}
                        </button>
                        {doc.pdfPath && (
                          <button
                            className="text-button"
                            onClick={() => void window.octa.documents.openPdf(doc.pdfPath!)}
                            type="button"
                          >
                            {label('clientsOpenPdf', locale)}
                          </button>
                        )}
                        <button
                          className="text-button danger"
                          aria-label={label('clientsDelete', locale)}
                          type="button"
                          onClick={() => {
                            if (window.confirm(interpolate(label('clientsDeleteDocumentConfirm', locale), { reference: doc.reference }))) {
                              void run(window.octa.documents.remove(doc.id))
                            }
                          }}
                        >
                          <Trash2 size={13} aria-hidden="true" />
                        </button>
                      </div>
                    </article>
                  ))}
                </section>
              )}
            </>
          )}
        </section>
      </div>
    </div>
  )
}

export { currency as formatClientCurrency }

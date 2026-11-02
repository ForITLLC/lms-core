import { ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { DARK_FG, DARK_FG_MUTED, DARK_HOVER_LINE_STRONG, DARK_HOVER_SURFACE_MUTED, DARK_LINE, DARK_SURFACE, DARK_SURFACE_MUTED } from './tokens'

/**
 * One column declaration, used for BOTH the desktop table and the mobile card.
 * Declare it once here — there is no second copy of the markup to drift, which
 * is the exact bug class (`md:hidden` cards + `hidden md:block` table, kept in
 * sync by hand) that `ResponsiveTable` exists to delete.
 */
export interface ResponsiveColumn<T> {
  /** Field on the row, also the React key for the cell. Synthetic columns
   *  (e.g. an "Actions" column with no backing field) pass any string + a
   *  `render`. */
  key: (keyof T & string) | (string & {})
  /** Column header text (table `<th>` / card `<dt>`). */
  header: string
  /** Cell renderer. Defaults to reading `row[key]`. */
  render?: (row: T, index: number) => ReactNode
  /** Text alignment for the cell. Default `'left'`. */
  align?: 'left' | 'right' | 'center'
  /** Extra classes on the cell. */
  className?: string
  /** Drop this column below a width (table view). Low-value detail only.
   *  A column with `hideBelow` set is also omitted from the card view (the
   *  narrowest layout), since cards render below `collapseAt`. */
  hideBelow?: 'sm' | 'md' | 'lg'
  /** Promote into the mobile card's header row instead of the `<dl>` body. */
  primary?: boolean
}

export interface ResponsiveTableProps<T> {
  data: T[]
  columns: ResponsiveColumn<T>[]
  /** Stable React key per row. */
  rowKey: (row: T, index: number) => string | number
  /** Below this width the table renders as cards; at/above it renders a
   *  `<table>`. Default `'md'` (768px) — forms-style tables pass `'sm'`. */
  collapseAt?: 'sm' | 'md' | 'lg'
  /** Shown when `data` is empty (both views). */
  emptyMessage?: string
  /** Accessible table caption (visually shown above as a small heading). */
  caption?: string
  /** Extra classes on the outer wrapper. */
  className?: string
  /** Row click handler — makes rows/cards interactive (button semantics). */
  onRowClick?: (row: T, index: number) => void
}

// Every branch below is a literal Tailwind sees when it scans this file. Never
// interpolate these: `` `${collapseAt}:hidden` `` produces classes the purge never emitted.
const COLLAPSE = {
  sm: { cards: 'sm:hidden', table: 'hidden sm:block' },
  md: { cards: 'md:hidden', table: 'hidden md:block' },
  lg: { cards: 'lg:hidden', table: 'hidden lg:block' },
} as const

const HIDE_BELOW = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
} as const

const ALIGN = {
  left: 'text-left',
  right: 'text-right',
  center: 'text-center',
} as const

function cell<T>(col: ResponsiveColumn<T>, row: T, index: number): ReactNode {
  if (col.render) return col.render(row, index)
  const v = (row as Record<string, unknown>)[col.key]
  return (v ?? '') as ReactNode
}

/**
 * The highest-leverage data-display primitive. Declare columns once; it owns
 * the table-or-card decision. At/above `collapseAt` it renders a semantic
 * `<table>` with neutral slate chrome; below it renders a `<ul>` of cards,
 * each a `<dl>` of label/value rows, with `primary` columns in the card header.
 *
 * Chrome is intentionally neutral (slate) so a client never sees ForIT brand
 * leak through a data grid — accents belong in cell `render`, via `var(--brand-*)`.
 */
export function ResponsiveTable<T>({
  data,
  columns,
  rowKey,
  collapseAt = 'md',
  emptyMessage = 'No records.',
  caption,
  className = '',
  onRowClick,
}: ResponsiveTableProps<T>) {
  const bp = COLLAPSE[collapseAt]
  const interactive = Boolean(onRowClick)
  const primaries = columns.filter((c) => c.primary)
  const cardBody = columns.filter((c) => !c.primary && !c.hideBelow)

  // Shared interactive semantics for both the mobile card and the table row.
  // A `<div role="button">` (not a real `<button>`) is used so cards/rows can
  // safely contain their own buttons, links, and badges without nesting
  // interactive elements — which is invalid HTML.
  const rowProps = (row: T, i: number) =>
    interactive
      ? {
          onClick: () => onRowClick!(row, i),
          role: 'button' as const,
          tabIndex: 0,
          onKeyDown: (e: ReactKeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault()
              onRowClick!(row, i)
            }
          },
        }
      : {}

  return (
    <div className={className}>
      {caption && (
        <h2 className={`mb-3 text-sm font-medium text-slate-500 ${DARK_FG_MUTED}`}>{caption}</h2>
      )}

      {/* Mobile: stacked cards (hidden at/above collapseAt). */}
      <ul className={`space-y-3 ${bp.cards}`}>
        {data.length === 0 ? (
          <li className={`rounded-xl border border-slate-200 bg-white p-4 text-center text-sm text-slate-400 ${DARK_LINE} ${DARK_SURFACE} ${DARK_FG_MUTED}`}>
            {emptyMessage}
          </li>
        ) : (
          data.map((row, i) => {
            return (
              <li key={rowKey(row, i)}>
                <div
                  {...rowProps(row, i)}
                  className={`block w-full rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm ${DARK_LINE} ${DARK_SURFACE} ${
                    interactive ? `cursor-pointer transition hover:border-slate-300 hover:shadow ${DARK_HOVER_LINE_STRONG}` : ''
                  }`}
                >
                  {primaries.length > 0 && (
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      {primaries.map((col) => (
                        <span
                          key={col.key}
                          className={`text-sm font-semibold text-slate-700 ${DARK_FG} ${col.className ?? ''}`}
                        >
                          {cell(col, row, i)}
                        </span>
                      ))}
                    </div>
                  )}
                  {cardBody.length > 0 && (
                    <dl className={`${primaries.length > 0 ? 'mt-3' : ''} space-y-2 text-sm`}>
                      {cardBody.map((col) => (
                        <div key={col.key} className="flex justify-between gap-3">
                          <dt className={`text-slate-500 ${DARK_FG_MUTED}`}>{col.header}</dt>
                          <dd className={`text-right text-slate-700 ${DARK_FG} ${col.className ?? ''}`}>
                            {cell(col, row, i)}
                          </dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
              </li>
            )
          })
        )}
      </ul>

      {/* Desktop: semantic table (hidden below collapseAt). */}
      <div className={`overflow-hidden rounded-lg border border-slate-200 bg-white ${DARK_LINE} ${DARK_SURFACE} ${bp.table}`}>
        <table className="w-full text-sm">
          {caption && <caption className="sr-only">{caption}</caption>}
          <thead className={`bg-slate-50 text-left text-slate-500 ${DARK_SURFACE_MUTED} ${DARK_FG_MUTED}`}>
            <tr>
              {columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  className={`px-4 py-2 font-medium ${ALIGN[col.align ?? 'left']} ${
                    col.hideBelow ? HIDE_BELOW[col.hideBelow] : ''
                  }`}
                >
                  {col.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {data.length === 0 ? (
              <tr>
                <td colSpan={columns.length} className={`px-4 py-6 text-center text-slate-400 ${DARK_FG_MUTED}`}>
                  {emptyMessage}
                </td>
              </tr>
            ) : (
              data.map((row, i) => (
                <tr
                  key={rowKey(row, i)}
                  {...rowProps(row, i)}
                  className={`border-t border-slate-100 ${DARK_LINE} ${
                    interactive ? `cursor-pointer transition hover:bg-slate-50 ${DARK_HOVER_SURFACE_MUTED}` : ''
                  }`}
                >
                  {columns.map((col) => (
                    <td
                      key={col.key}
                      className={`px-4 py-2 text-slate-600 ${DARK_FG} ${ALIGN[col.align ?? 'left']} ${
                        col.hideBelow ? HIDE_BELOW[col.hideBelow] : ''
                      } ${col.className ?? ''}`}
                    >
                      {cell(col, row, i)}
                    </td>
                  ))}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  )
}

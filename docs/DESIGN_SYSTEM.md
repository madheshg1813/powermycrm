# PowerMyCRM design system

PowerMyCRM uses the same visual language as Power My Tutor (`app.powermytutor.com`), the sister
RuleTheTop product. The values below were read from that app's live CSS on 2026-11-11, not
estimated from a screenshot. This supersedes the emerald/Montserrat starting direction in the
original brief, on the product owner's instruction.

The single source of truth in code is `apps/web/tailwind.config.ts` (tokens) and
`apps/web/src/app/globals.css` (component classes). Pages must not define their own colours,
radii or button styles.

## Colour tokens

| Token | Value | Use |
|---|---|---|
| `cream` | `#F5F1EA` | App background, sidebar |
| `surface` | `#FFFFFF` | Cards, inputs, tables |
| `ink` | `#1C1917` | Text, active nav pill, dark banner |
| `ink-soft` | `#44403C` | Labels, secondary headings |
| `ink-muted` | `#78716C` | Secondary text |
| `ink-faint` | `#A8A29E` | Placeholders, disabled |
| `line` | `rgba(28,25,23,0.10)` | Card borders, dividers |
| `line-strong` | `rgba(28,25,23,0.15)` | Input and ghost-button borders |
| `brand` | `#EA5A2A` | Primary action only |
| `brand-hover` | `#D64C1F` | Primary hover |
| `green` | `#168A4C` | Positive state, accent word in a page greeting |
| `green-soft` | `#E8F3EA` | Positive pill background |
| `danger` | `#B42318` | Destructive actions, errors |
| `amber` / `amber-soft` | `#B54708` / `#FEF0C7` | Warnings, overdue |

Rule: one orange primary action per view. Everything else is ghost (white, hairline border) or ink.

## Typography

- Display: **Sora** 600/700/800, letter-spacing −0.025em. Page titles, card titles, KPI numbers.
- Interface: **Inter** 400/500/600. Everything else.
- Scale inside the app: page title 28px, card title 17px, body 14px, table 13.5px, caption 12px, overline 11px uppercase with 0.08em tracking.

## Shape and elevation

- Buttons and pills: fully rounded (`9999px`). Button padding 8×16, 14px/600. Small: 6×12, 13px.
- Inputs: 12px radius, 1px `line-strong`, focus border `ink` with a 2px soft ring.
- Cards: 16px radius, 1px `line`, no shadow at rest. `shadow-soft` only on overlays and hover.
- Sidebar: 248px, cream, active item is a solid ink pill with white text; collapses to 68px icons.

## Components

`Button` (primary, ghost, ink, on-ink, danger; sm), `Input`, `Select`, `Textarea`, `Checkbox`,
`Field` (label + error), `Card`, `Pill`, `Modal`, `Drawer`, `ConfirmDialog`, `Toast`, `DataTable`
(sortable header, selection, pagination, bulk bar), `EmptyState`, `ErrorState`, `Skeleton`,
`Tabs`, `Menu`, `StatCard`, `PageHeader`, `FilterBar`. Icons: Lucide, 18px, 1.75 stroke.

## Layout rules

- Top bar 64px: global search (Ctrl K), workspace switcher, notifications, orange "New" quick-add.
- Content max-width 1240px for dashboards; data tables use the full width.
- Density: table rows 44px, form rows 8px gap, card padding 20px.
- Mobile (<768px): sidebar becomes a slide-over, tables become stacked record cards, primary
  actions move to a bottom bar. Layouts are redesigned for the breakpoint, not scaled down.

## States

Every data view implements loading (skeleton), empty (icon, one sentence, one action), error
(message, retry) and permission-denied states.

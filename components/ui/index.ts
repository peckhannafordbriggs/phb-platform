/**
 * The platform's shared UI kit (2026-11-10).
 *
 * Promoted from the kit Cost Intelligence built for itself, with the pieces
 * Freeze Protection's added (fields, the empty state, the callout). Every
 * module's chrome is drawn from here; a module's own `ui/` directory, where
 * one still exists, only re-exports these.
 *
 * Colours are not the kit's business. A component reads the platform tokens
 * and the module header's `--module-accent`, so the same button is red in
 * Change Orders and teal in Cost Intelligence without either module telling
 * it so. The three fills a button can take (`--phb-red-btn`, white, the
 * danger ink) and the five tones a state can take are platform decisions,
 * recorded in app/globals.css, and the only colour the kit knows.
 *
 * docs/07-conventions.md -> UI; WHY-ITS-BUILT-THIS-WAY.md § 78.
 */
export { Button } from "./Button";
export { Callout } from "./Callout";
export { Card } from "./Card";
export { Dropdown, type DropdownOption } from "./Dropdown";
export { Empty } from "./Empty";
export {
  DateField,
  FieldLabel,
  INPUT,
  NumberField,
  SelectField,
  TextArea,
  TextField,
  YesNo,
} from "./Field";
export { FilterMenu } from "./FilterMenu";
export { Label } from "./Label";
export { LinkPending } from "./LinkPending";
export { Pill, type PillTone, type Tone } from "./Pill";
export { SearchBar, type SearchResult } from "./SearchBar";
export { Segmented } from "./Segmented";
export { TabBar, type TabItem } from "./TabBar";
export { Table } from "./Table";
export { SpendPerDayChart, UsageBreakdownTable, UsageStat, formatMoney, formatTokens } from "./Usage";

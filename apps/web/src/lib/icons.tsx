import {
  Asterisk,
  AtSign,
  Boxes,
  Briefcase,
  Building2,
  Calendar1,
  CalendarDays,
  ChartNoAxesColumn,
  CheckSquare,
  ChevronDown,
  ChevronRight,
  ClipboardList,
  Clock,
  Contact,
  ContactRound,
  FileText,
  Files,
  Gauge,
  Gift,
  Handshake,
  KeyRound,
  LayoutGrid,
  Mail,
  MoreHorizontal,
  Package,
  PanelLeft,
  Phone,
  Plus,
  Receipt,
  RefreshCw,
  Repeat,
  Search,
  Settings,
  Share2,
  ShoppingCart,
  Store,
  Tag,
  Trash2,
  TrendingUp,
  User,
  Users,
  Wallet,
} from "lucide-react";

/**
 * The icons the sidebar can draw, by name.
 *
 * A module names an icon in a string rather than importing one, because a
 * module is built separately and shipped as a bundle — it cannot share this
 * application's React tree, and two copies of an icon library in one page is
 * a hundred kilobytes nobody sees.
 *
 * An unknown name falls back rather than throwing. A module built against a
 * later host will ask for icons this one has never heard of, and a missing
 * picture must never be the reason a sidebar fails to render.
 */
const ICONS = {
  asterisk: Asterisk,
  "at-sign": AtSign,
  boxes: Boxes,
  briefcase: Briefcase,
  building: Building2,
  calendar: CalendarDays,
  "calendar-1": Calendar1,
  chart: ChartNoAxesColumn,
  "check-square": CheckSquare,
  "chevron-down": ChevronDown,
  "chevron-right": ChevronRight,
  clipboard: ClipboardList,
  clock: Clock,
  contact: Contact,
  "contact-round": ContactRound,
  handshake: Handshake,
  key: KeyRound,
  "file-text": FileText,
  files: Files,
  gauge: Gauge,
  gift: Gift,
  layout: LayoutGrid,
  mail: Mail,
  "more-horizontal": MoreHorizontal,
  package: Package,
  "panel-left": PanelLeft,
  phone: Phone,
  plus: Plus,
  search: Search,
  tag: Tag,
  trash: Trash2,
  receipt: Receipt,
  "refresh-cw": RefreshCw,
  repeat: Repeat,
  settings: Settings,
  share: Share2,
  shop: ShoppingCart,
  store: Store,
  "trending-up": TrendingUp,
  user: User,
  users: Users,
  wallet: Wallet,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 18,
}: {
  name: IconName | (string & {});
  size?: number;
}) {
  const Glyph = ICONS[name as IconName] ?? LayoutGrid;
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
      aria-hidden="true"
      className="shrink-0"
    />
  );
}

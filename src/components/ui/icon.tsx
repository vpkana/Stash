'use client';

import {
  AlertTriangle,
  Archive,
  ArrowLeft,
  ArrowUpDown,
  Atom,
  BookOpen,
  Briefcase,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  Clapperboard,
  Clock,
  Code,
  Copy,
  Download,
  ExternalLink,
  FileText,
  Folder,
  FolderInput,
  FolderOpen,
  FolderPlus,
  FolderTree,
  Gamepad2,
  GraduationCap,
  Home,
  Image as ImageIcon,
  Inbox,
  Info,
  Languages,
  Library,
  Lightbulb,
  Link2,
  Loader2,
  Lock,
  Mail,
  MapPin,
  Monitor,
  Moon,
  MoreHorizontal,
  Music,
  Palette,
  Pencil,
  Plane,
  Play,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  Settings,
  Share2,
  Shield,
  ShoppingBag,
  Sparkles,
  Star,
  Sun,
  Tag,
  Trash2,
  Upload,
  Users,
  Wallet,
  Wrench,
  X,
  Zap,
} from '@/components/ui/icons';
import type { IconType } from '@/components/ui/icons';
import { cn } from '@/lib/utils';

/**
 * Folder icons are stored as stable string keys rather than raw glyphs, so the
 * data model survives a future icon-set change and the picker has a bounded,
 * reviewable vocabulary.
 */
export const ICONS = {
  folder: Folder,
  'folder-open': FolderOpen,
  inbox: Inbox,
  star: Star,
  clock: Clock,
  tag: Tag,
  link: Link2,
  note: FileText,
  code: Code,
  terminal: Zap,
  atom: Atom,
  'graduation-cap': GraduationCap,
  'book-open': BookOpen,
  library: Library,
  lightbulb: Lightbulb,
  'file-text': FileText,
  'clapperboard': Clapperboard,
  'gamepad': Gamepad2,
  music: Music,
  play: Play,
  image: ImageIcon,
  palette: Palette,
  briefcase: Briefcase,
  wallet: Wallet,
  'shopping-bag': ShoppingBag,
  users: Users,
  mail: Mail,
  'map-pin': MapPin,
  plane: Plane,
  languages: Languages,
  'wrench': Wrench,
  shield: Shield,
  sparkles: Sparkles,
  rocket: Rocket,
  'arrow-up-down': ArrowUpDown,
  archive: Archive,
  'folder-input': FolderInput,
  'folder-tree': FolderTree,
  'folder-plus': FolderPlus,
} as const;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

export function isIconName(value: string | undefined): value is IconName {
  return Boolean(value && value in ICONS);
}

/** Curated shortlist offered in the folder editor, in preference order. */
export const FOLDER_ICON_CHOICES: IconName[] = [
  'folder',
  'star',
  'code',
  'graduation-cap',
  'book-open',
  'clapperboard',
  'lightbulb',
  'briefcase',
  'palette',
  'music',
  'play',
  'image',
  'gamepad',
  'shopping-bag',
  'users',
  'plane',
  'map-pin',
  'wrench',
  'shield',
  'sparkles',
  'archive',
  'inbox',
];

export interface IconProps {
  name?: IconName | string | undefined;
  className?: string;
  size?: number;
  strokeWidth?: number;
}

export function Icon({ name, className, size = 20, strokeWidth = 1.75 }: IconProps) {
  const Component: IconType = isIconName(name) ? ICONS[name] : Folder;
  return <Component className={cn('shrink-0', className)} size={size} strokeWidth={strokeWidth} aria-hidden />;
}

/** Named UI glyphs used by the chrome, kept separate from folder icons. */
export const UI = {
  Home,
  Library,
  Search,
  Settings,
  Plus,
  Check,
  CircleCheck,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  ArrowLeft,
  ArrowUpDown,
  MoreHorizontal,
  Pencil,
  Trash2,
  Star,
  Lock,
  ExternalLink,
  Copy,
  Download,
  Upload,
  Share2,
  Sun,
  Moon,
  Monitor,
  AlertTriangle,
  Info,
  X,
  Loader2,
  RefreshCw,
  FolderTree,
  FolderPlus,
  Clock,
  Tag,
  Archive,
} as const;

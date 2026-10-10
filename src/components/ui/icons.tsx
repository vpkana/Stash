'use client';

import * as React from 'react';
import type { IconProps as PhosphorProps } from '@phosphor-icons/react';
import {
  Airplane as PhAirplane,
  Archive as PhArchive,
  ArrowCounterClockwise as PhArrowCounterClockwise,
  ArrowElbowDownRight as PhArrowElbowDownRight,
  ArrowLeft as PhArrowLeft,
  ArrowSquareOut as PhArrowSquareOut,
  ArrowsClockwise as PhArrowsClockwise,
  ArrowsDownUp as PhArrowsDownUp,
  Atom as PhAtom,
  Bag as PhBag,
  BookOpenText as PhBookOpenText,
  Books as PhBooks,
  Briefcase as PhBriefcase,
  CaretDown as PhCaretDown,
  CaretLeft as PhCaretLeft,
  CaretRight as PhCaretRight,
  Check as PhCheck,
  CheckCircle as PhCheckCircle,
  CircleNotch as PhCircleNotch,
  Clock as PhClock,
  Code as PhCode,
  Copy as PhCopy,
  Desktop as PhDesktop,
  DeviceMobile as PhDeviceMobile,
  DotsSixVertical as PhDotsSixVertical,
  DotsThree as PhDotsThree,
  DownloadSimple as PhDownloadSimple,
  EnvelopeSimple as PhEnvelopeSimple,
  Eye as PhEye,
  EyeSlash as PhEyeSlash,
  FileJs as PhFileJs,
  FilePlus as PhFilePlus,
  FileText as PhFileText,
  FilmSlate as PhFilmSlate,
  Fingerprint as PhFingerprint,
  Folder as PhFolder,
  FolderOpen as PhFolderOpen,
  FolderPlus as PhFolderPlus,
  FolderUser as PhFolderUser,
  Folders as PhFolders,
  GameController as PhGameController,
  Gear as PhGear,
  GraduationCap as PhGraduationCap,
  House as PhHouse,
  Image as PhImage,
  Info as PhInfo,
  Key as PhKey,
  Lightning as PhLightning,
  Lightbulb as PhLightbulb,
  LinkBreak as PhLinkBreak,
  LinkSimple as PhLinkSimple,
  ListBullets as PhListBullets,
  ListChecks as PhListChecks,
  ListNumbers as PhListNumbers,
  Lock as PhLock,
  LockKey as PhLockKey,
  LockOpen as PhLockOpen,
  MagnifyingGlass as PhMagnifyingGlass,
  MagnifyingGlassMinus as PhMagnifyingGlassMinus,
  MapPin as PhMapPin,
  Moon as PhMoon,
  MusicNotes as PhMusicNotes,
  Notebook as PhNotebook,
  PaintBrush as PhPaintBrush,
  Palette as PhPalette,
  Pencil as PhPencil,
  PencilLine as PhPencilLine,
  Play as PhPlay,
  Plus as PhPlus,
  Quotes as PhQuotes,
  RocketLaunch as PhRocketLaunch,
  ShareNetwork as PhShareNetwork,
  Shield as PhShield,
  ShieldCheck as PhShieldCheck,
  ShieldWarning as PhShieldWarning,
  Sparkle as PhSparkle,
  Stack as PhStack,
  Star as PhStar,
  Sun as PhSun,
  Tag as PhTag,
  TextB as PhTextB,
  TextH as PhTextH,
  TextItalic as PhTextItalic,
  TextStrikethrough as PhTextStrikethrough,
  Translate as PhTranslate,
  Trash as PhTrash,
  Tray as PhTray,
  UploadSimple as PhUploadSimple,
  Users as PhUsers,
  Wallet as PhWallet,
  Warning as PhWarning,
  Wrench as PhWrench,
  X as PhX,
} from '@phosphor-icons/react';

/**
 * The app's icon vocabulary.
 *
 * One module, one set: [Phosphor](https://phosphoricons.com) rather than the
 * uniform-stroke set the app used before. Phosphor is a *designed* family — it
 * has real weights, a slightly rounder geometry and icons drawn with some
 * personality, which is most of the difference between an interface that looks
 * considered and one that looks generated.
 *
 * ## Why this is an adapter and not a find-and-replace
 *
 * Every call site in the app says `size={19} strokeWidth={1.9}`. Phosphor has no
 * `strokeWidth` — it has `weight` (`thin | light | regular | bold | fill |
 * duotone`). Rather than touch ninety-odd icon usages, `strokeWidth` is accepted
 * here and translated into a weight, and the vocabulary below keeps the names the
 * app already uses. Two consequences worth knowing:
 *
 *  - the *look* of every icon changed without a single call site changing, and
 *  - call sites that pass `strokeWidth={2.4}` now get a **bold** icon and ones
 *    that pass `{3}` get **fill**, so the existing weights in the app already
 *    express hierarchy — an action icon is heavier than a decorative one, which
 *    is exactly the intent the old numbers encoded.
 *
 * `strokeWidth` is not part of Phosphor's API and must not leak into new code:
 * pass `weight` directly when writing something new.
 */

export type IconWeight = NonNullable<PhosphorProps['weight']>;

export interface IconProps extends Omit<PhosphorProps, 'weight'> {
  /**
   * Legacy stroke weight, translated to a Phosphor `weight`. Kept so the ~90
   * existing usages keep their intended visual hierarchy.
   */
  strokeWidth?: number;
  weight?: IconWeight;
}

export type IconType = React.ComponentType<IconProps>;

/**
 * Stroke widths the app already used, mapped onto Phosphor's six weights.
 *
 * The thresholds are placed where the app's numbers actually cluster: 1.7–1.8
 * for large decorative glyphs, 1.9–2.0 for the default, 2.2–2.5 for actions, and
 * 2.6+ for the handful of solid marks (a filled tick, a filled star).
 */
function weightFor(strokeWidth?: number): IconWeight {
  if (strokeWidth === undefined) return 'regular';
  if (strokeWidth >= 2.6) return 'fill';
  if (strokeWidth >= 2.15) return 'bold';
  if (strokeWidth >= 1.75) return 'regular';
  return 'light';
}

function icon(Base: React.ComponentType<PhosphorProps>, displayName: string): IconType {
  const Wrapped = React.forwardRef<SVGSVGElement, IconProps>(
    ({ size = 20, strokeWidth, weight, ...rest }, ref) => (
      <Base ref={ref} size={size} weight={weight ?? weightFor(strokeWidth)} {...rest} />
    ),
  );
  Wrapped.displayName = displayName;
  return Wrapped;
}

// --- Navigation and chrome --------------------------------------------------
export const Home = icon(PhHouse, 'Home');
export const Library = icon(PhBooks, 'Library');
export const Search = icon(PhMagnifyingGlass, 'Search');
export const Settings = icon(PhGear, 'Settings');
export const NotebookPen = icon(PhNotebook, 'NotebookPen');
export const Inbox = icon(PhTray, 'Inbox');
export const MoreHorizontal = icon(PhDotsThree, 'MoreHorizontal');
export const ChevronRight = icon(PhCaretRight, 'ChevronRight');
export const ChevronLeft = icon(PhCaretLeft, 'ChevronLeft');
export const ChevronDown = icon(PhCaretDown, 'ChevronDown');
export const ArrowLeft = icon(PhArrowLeft, 'ArrowLeft');
export const ArrowUpDown = icon(PhArrowsDownUp, 'ArrowUpDown');
export const X = icon(PhX, 'X');
export const Plus = icon(PhPlus, 'Plus');
export const Check = icon(PhCheck, 'Check');
export const CheckCircle2 = icon(PhCheckCircle, 'CheckCircle2');
export const CircleCheck = icon(PhCheckCircle, 'CircleCheck');
export const Loader2 = icon(PhCircleNotch, 'Loader2');
export const Info = icon(PhInfo, 'Info');
export const AlertTriangle = icon(PhWarning, 'AlertTriangle');

// --- Folders ----------------------------------------------------------------
export const Folder = icon(PhFolder, 'Folder');
export const FolderOpen = icon(PhFolderOpen, 'FolderOpen');
export const FolderPlus = icon(PhFolderPlus, 'FolderPlus');
export const FolderTree = icon(PhFolders, 'FolderTree');
export const FolderInput = icon(PhFolderUser, 'FolderInput');
export const Layers = icon(PhStack, 'Layers');

// --- Links ------------------------------------------------------------------
export const Link2 = icon(PhLinkSimple, 'Link2');
export const Link2Off = icon(PhLinkBreak, 'Link2Off');
export const ExternalLink = icon(PhArrowSquareOut, 'ExternalLink');
export const Share2 = icon(PhShareNetwork, 'Share2');
export const Copy = icon(PhCopy, 'Copy');
export const MapPin = icon(PhMapPin, 'MapPin');
export const Clock = icon(PhClock, 'Clock');
export const Star = icon(PhStar, 'Star');
export const Tag = icon(PhTag, 'Tag');
export const Clapperboard = icon(PhFilmSlate, 'Clapperboard');

// --- Notes and writing ------------------------------------------------------
export const FilePlus2 = icon(PhFilePlus, 'FilePlus2');
export const FileText = icon(PhFileText, 'FileText');
export const FileJson = icon(PhFileJs, 'FileJson');
export const Pencil = icon(PhPencil, 'Pencil');
export const PencilLine = icon(PhPencilLine, 'PencilLine');
export const Bold = icon(PhTextB, 'Bold');
export const Italic = icon(PhTextItalic, 'Italic');
export const Strikethrough = icon(PhTextStrikethrough, 'Strikethrough');
export const Heading2 = icon(PhTextH, 'Heading2');
export const List = icon(PhListBullets, 'List');
export const ListChecks = icon(PhListChecks, 'ListChecks');
export const ListOrdered = icon(PhListNumbers, 'ListOrdered');
export const Quote = icon(PhQuotes, 'Quote');
export const Code = icon(PhCode, 'Code');
export const BookOpen = icon(PhBookOpenText, 'BookOpen');
export const CornerDownRight = icon(PhArrowElbowDownRight, 'CornerDownRight');

// --- Privacy ----------------------------------------------------------------
export const Lock = icon(PhLock, 'Lock');
export const LockKeyhole = icon(PhLockKey, 'LockKeyhole');
export const Unlock = icon(PhLockOpen, 'Unlock');
export const Shield = icon(PhShield, 'Shield');
export const ShieldAlert = icon(PhShieldWarning, 'ShieldAlert');
export const ShieldCheck = icon(PhShieldCheck, 'ShieldCheck');
export const Fingerprint = icon(PhFingerprint, 'Fingerprint');
export const Eye = icon(PhEye, 'Eye');
export const EyeOff = icon(PhEyeSlash, 'EyeOff');

// --- Data, backup and maintenance ------------------------------------------
export const Archive = icon(PhArchive, 'Archive');
export const Trash2 = icon(PhTrash, 'Trash2');
export const Download = icon(PhDownloadSimple, 'Download');
export const Upload = icon(PhUploadSimple, 'Upload');
export const RefreshCw = icon(PhArrowsClockwise, 'RefreshCw');
export const RotateCcw = icon(PhArrowCounterClockwise, 'RotateCcw');
export const Wrench = icon(PhWrench, 'Wrench');

// --- Personality, used where a folder or a note picks an icon ---------------
export const Atom = icon(PhAtom, 'Atom');
export const Briefcase = icon(PhBriefcase, 'Briefcase');
export const Gamepad2 = icon(PhGameController, 'Gamepad2');
export const GraduationCap = icon(PhGraduationCap, 'GraduationCap');
export const Lightbulb = icon(PhLightbulb, 'Lightbulb');
export const Music = icon(PhMusicNotes, 'Music');
export const Palette = icon(PhPalette, 'Palette');
export const PaintBrush = icon(PhPaintBrush, 'PaintBrush');
export const Plane = icon(PhAirplane, 'Plane');
export const Rocket = icon(PhRocketLaunch, 'Rocket');
export const ShoppingBag = icon(PhBag, 'ShoppingBag');
export const Sparkles = icon(PhSparkle, 'Sparkles');
export const Users = icon(PhUsers, 'Users');
export const Wallet = icon(PhWallet, 'Wallet');
export const Zap = icon(PhLightning, 'Zap');
export const Play = icon(PhPlay, 'Play');
/** The grip on a reorderable row. Drawn as dots because a handle is a hint, not a control. */
export const DotsSixVertical = icon(PhDotsSixVertical, 'DotsSixVertical');
export const Key = icon(PhKey, 'Key');
export const Image = icon(PhImage, 'Image');
export const Languages = icon(PhTranslate, 'Languages');
export const Mail = icon(PhEnvelopeSimple, 'Mail');
export const Monitor = icon(PhDesktop, 'Monitor');
export const Smartphone = icon(PhDeviceMobile, 'Smartphone');
export const Sun = icon(PhSun, 'Sun');
export const Moon = icon(PhMoon, 'Moon');
export const SearchX = icon(PhMagnifyingGlassMinus, 'SearchX');

'use client';

import * as React from 'react';
import { Check } from '@/components/ui/icons';
import { parseMarkdown, renderInline, type InlineNode, type MarkdownBlock } from '@/lib/markdown';
import { openExternal } from '@/lib/open-external';
import { cn } from '@/lib/utils';

/**
 * Renders note Markdown.
 *
 * Produces React elements rather than an HTML string, so user content can never
 * inject markup: there is no `dangerouslySetInnerHTML` anywhere in the renderer,
 * which makes a note safe by construction rather than by sanitising afterwards.
 *
 * Checklists are interactive here. Tapping one rewrites exactly its source line,
 * so a note can be used as a real checklist without leaving the reading view.
 */

export interface MarkdownViewProps {
  content: string;
  /** Omit to render checklists as read-only. */
  onToggleChecklist?: (line: number) => void;
  className?: string;
}

export function MarkdownView({ content, onToggleChecklist, className }: MarkdownViewProps) {
  const blocks = React.useMemo(() => parseMarkdown(content), [content]);

  if (content.trim().length === 0) {
    return <p className={cn('text-row text-subtle italic', className)}>Nothing written yet.</p>;
  }

  return (
    <div className={cn('flex flex-col gap-3 text-row leading-relaxed text-fg', className)}>
      {blocks.map((block, index) => (
        <Block
          key={`${block.kind}-${block.line}-${index}`}
          block={block}
          onToggleChecklist={onToggleChecklist}
        />
      ))}
    </div>
  );
}

function Block({
  block,
  onToggleChecklist,
}: {
  block: MarkdownBlock;
  onToggleChecklist?: (line: number) => void;
}) {
  switch (block.kind) {
    case 'heading': {
      const sizes: Record<number, string> = {
        1: 'text-display font-semibold tracking-tight',
        2: 'text-title font-semibold tracking-tight',
        3: 'text-title font-semibold',
        4: 'text-title font-semibold',
        5: 'text-row font-semibold',
        6: 'text-body font-semibold text-muted',
      };
      const Tag = (`h${block.level}` as unknown) as 'h1';
      return (
        <Tag className={cn('text-fg', sizes[block.level] ?? sizes[3])}>
          <Inline nodes={renderInline(block.text)} />
        </Tag>
      );
    }

    case 'paragraph':
      return (
        <p className="whitespace-pre-wrap break-words">
          <Inline nodes={renderInline(block.text)} />
        </p>
      );

    case 'quote':
      return (
        <blockquote className="border-l-2 border-border-strong pl-3 text-muted">
          <Inline nodes={renderInline(block.text)} />
        </blockquote>
      );

    case 'divider':
      return <hr className="border-t border-border" />;

    case 'code':
      return (
        <pre className="scroll-area overflow-x-auto rounded-xl border border-border bg-surface-2 px-3.5 py-3 text-meta leading-relaxed">
          <code className="font-mono whitespace-pre text-fg">{block.code}</code>
        </pre>
      );

    case 'list':
      return (
        <ul className="flex flex-col gap-1.5">
          {block.items.map((item, index) => (
            <li
              key={`${item.line}-${index}`}
              className="flex items-start gap-2"
              style={{ paddingLeft: Math.min(item.indent, 4) * 12 }}
            >
              {item.checked === null ? (
                <span className="mt-[0.4em] shrink-0 text-subtle" aria-hidden>
                  {block.ordered ? (
                    <span className="text-meta font-medium tabular-nums">{block.start + index}.</span>
                  ) : (
                    <span className="text-row leading-none">•</span>
                  )}
                </span>
              ) : (
                <ChecklistBox
                  checked={item.checked}
                  label={item.text}
                  {...(onToggleChecklist ? { onToggle: () => onToggleChecklist(item.line) } : {})}
                />
              )}
              <span className={cn('min-w-0 flex-1 break-words', item.checked && 'text-muted line-through')}>
                <Inline nodes={renderInline(item.text)} />
              </span>
            </li>
          ))}
        </ul>
      );

    default:
      return null;
  }
}

function ChecklistBox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle?: () => void;
}) {
  const interactive = Boolean(onToggle);
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label || 'Checklist item'}
      disabled={!interactive}
      onClick={onToggle}
      className={cn(
        'mt-[0.15em] flex size-[1.125rem] shrink-0 items-center justify-center rounded-md border transition-colors',
        checked ? 'border-accent bg-accent text-accent-fg' : 'border-border-strong bg-surface',
        interactive && 'tap tap-scale',
      )}
    >
      {checked ? <Check size={12} strokeWidth={3.2} aria-hidden /> : null}
    </button>
  );
}

function Inline({ nodes }: { nodes: readonly InlineNode[] }) {
  return (
    <>
      {nodes.map((node, index) => {
        switch (node.type) {
          case 'bold':
            return (
              <strong key={index} className="font-semibold">
                {node.value}
              </strong>
            );
          case 'italic':
            return (
              <em key={index} className="italic">
                {node.value}
              </em>
            );
          case 'strike':
            return (
              <s key={index} className="text-muted">
                {node.value}
              </s>
            );
          case 'code':
            return (
              <code
                key={index}
                className="rounded bg-surface-2 px-1 py-0.5 font-mono text-[0.85em] break-words text-fg"
              >
                {node.value}
              </code>
            );
          case 'link':
            return <NoteLink key={index} href={node.href} label={node.value} />;
          case 'text':
          default:
            return <React.Fragment key={index}>{node.value}</React.Fragment>;
        }
      })}
    </>
  );
}

function NoteLink({ href, label }: { href: string; label: string }) {
  const external = /^https?:\/\//i.test(href);
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      onClick={(event) => {
        // In the Android WebView, following an <a> would navigate the app away
        // from Stash, so external links go through Chrome Custom Tabs instead.
        if (!external) return;
        event.preventDefault();
        void openExternal(href);
      }}
      className="tap rounded font-medium text-accent underline decoration-accent/40 underline-offset-2 active:bg-accent-soft"
    >
      {label || href}
    </a>
  );
}

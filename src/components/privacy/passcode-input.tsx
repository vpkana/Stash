'use client';

import * as React from 'react';
import { Eye, EyeOff } from '@/components/ui/icons';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';

/**
 * Passcode entry.
 *
 * The value lives only in this component's state and is handed straight to the
 * keyring, which derives a wrapping key from it and forgets it. It is not put in
 * a store, not mirrored to storage, and not sent anywhere — so the shortest
 * possible lifetime is a feature, not an oversight.
 *
 * A passcode is *never* stored or verified against a saved hash: the AES-GCM
 * authentication tag on the wrapped key is the verifier. That removes an entire
 * class of bugs (a stored hash is a crackable artefact) and is why a wrong
 * passcode and a corrupted keyring are indistinguishable — both simply fail to
 * unwrap, and both leave the vault exactly as it was.
 */

export interface PasscodeInputProps {
  label: string;
  /**
   * Field id, so the label points at this input.
   *
   * Defaulted rather than fixed because a screen can legitimately need two of
   * these — a passcode and its confirmation — and two elements sharing one id is
   * a label that points at whichever came first.
   */
  id?: string;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  placeholder?: string;
  autoFocus?: boolean;
  disabled?: boolean;
  /** Rendered under the field, e.g. a mismatch or failure message. */
  hint?: React.ReactNode;
  tone?: 'default' | 'danger';
  className?: string;
}

export function PasscodeInput({
  label,
  id = 'stash-passcode',
  value,
  onChange,
  onSubmit,
  placeholder = 'Passcode',
  autoFocus = false,
  disabled = false,
  hint,
  tone = 'default',
  className,
}: PasscodeInputProps) {
  const [reveal, setReveal] = React.useState(false);

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-meta font-medium text-muted">
        {label}
      </label>
      <div className="relative">
        <Input
          id={id}
          type={reveal ? 'text' : 'password'}
          value={value}
          autoFocus={autoFocus}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && onSubmit) {
              event.preventDefault();
              onSubmit();
            }
          }}
          placeholder={placeholder}
          // No autocomplete, no autofill, no spellcheck: a password manager
          // offering to save a vault passcode would put it somewhere we cannot
          // vouch for.
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          inputMode="text"
          enterKeyHint="go"
          className="pr-11"
        />
        <button
          type="button"
          onClick={() => setReveal((current) => !current)}
          aria-label={reveal ? 'Hide passcode' : 'Show passcode'}
          aria-pressed={reveal}
          className="tap absolute top-1/2 right-1 flex size-9 -translate-y-1/2 items-center justify-center rounded-lg text-subtle active:bg-surface-3"
        >
          {reveal ? <EyeOff size={17} strokeWidth={1.9} aria-hidden /> : <Eye size={17} strokeWidth={1.9} aria-hidden />}
        </button>
      </div>
      {hint ? (
        <p className={cn('text-meta leading-relaxed', tone === 'danger' ? 'text-danger' : 'text-subtle')}>
          {hint}
        </p>
      ) : null}
    </div>
  );
}


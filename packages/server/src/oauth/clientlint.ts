// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import type { WithId } from '@medplum/core';
import type { ClientApplication } from '@medplum/fhirtypes';
import { getClientRedirectUris } from './clients';

/**
 * Severity of a single OAuth client configuration finding, and of the aggregate result.
 */
export type OAuthClientLintStatus = 'pass' | 'warning' | 'fail';

/**
 * The complete set of rule identifiers {@link lintOAuthClient} can emit, and the condition each one reports. Every
 * finding carries one of these six identifiers; no other identifier is ever emitted.
 */
export const OAuthClientLintRule = {
  /** A registered redirect URI that parses as an origin with no callback path on a non-loopback host. */
  BareOrigin: 'OCS-001',
  /** A registered redirect URI whose stored value contains a wildcard character. */
  Wildcard: 'OCS-002',
  /** A parseable registered redirect URI the project accepts as a text prefix rather than as an exact string. */
  PrefixMatchingEnabled: 'OCS-003',
  /** A client id or registered redirect URI that also identifies or addresses a standard OAuth client. */
  RegistrationDiscoverable: 'OCS-004',
  /** No redirect URI is configured, so no redirect URI rule applies. Always `pass`. */
  NoRedirectUri: 'OCS-005',
  /**
   * A registered entry the redirect URI rules cannot be applied to: one stored as something other than a string, or
   * one no absolute URL can be parsed from.
   */
  UnparseableRedirectUri: 'OCS-006',
} as const;

/**
 * The identifier of one rule in {@link OAuthClientLintRule}.
 */
export type OAuthClientLintRuleId = (typeof OAuthClientLintRule)[keyof typeof OAuthClientLintRule];

/**
 * The outcome of one rule for one client application.
 */
export interface OAuthClientLintFinding {
  readonly ruleId: OAuthClientLintRuleId;
  readonly status: OAuthClientLintStatus;
  /**
   * The registered redirect URI that triggered the finding. Absent when the finding is not scoped to a URI, and when
   * the registered entry that triggered it is not stored as a string.
   */
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

/**
 * The evaluation of one client application.
 */
export interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  /** Every registered redirect URI stored as a string, in registration order. */
  readonly redirectUris: string[];
  /** The highest severity among `findings`, or `pass` when there are none. */
  readonly status: OAuthClientLintStatus;
  readonly findings: OAuthClientLintFinding[];
}

/**
 * A standard OAuth client that unauthenticated dynamic client registration can resolve.
 */
export interface RegistrationDiscoverableClient {
  readonly id?: string;
  readonly redirectUris: readonly string[];
  readonly source: 'built-in' | 'config';
}

/**
 * Evaluation inputs for {@link lintOAuthClient} that the client application resource does not carry.
 */
export interface OAuthClientLintOptions {
  /** True when the project enables the `allow-dangerous-redirect` setting. */
  readonly partialRedirectMatchEnabled?: boolean;
  /** Standard OAuth clients in the order registration resolves them. */
  readonly registrationDiscoverableClients?: readonly RegistrationDiscoverableClient[];
}

interface OAuthClientLintCopy {
  readonly reason: string;
  readonly remediation: string;
}

const LINT_COPY: Record<Exclude<OAuthClientLintRuleId, 'OCS-004'>, OAuthClientLintCopy> = {
  'OCS-001': {
    reason:
      "Registered as an origin with no callback path, so the authorization response is delivered to this host's root page. Any open redirect, third-party script or user-controlled content on that root page can forward the authorization code onwards, and a root page is rarely written with that responsibility in mind.",
    remediation:
      'Register the exact callback URL the application uses, including its path — for example https://app.example.com/oauth/callback — and remove the origin-only entry.',
  },
  'OCS-002': {
    reason:
      'Contains a wildcard. Redirect URIs are compared by exact string, so this entry never matches a real authorization request; where the same value is used on a server that does expand patterns, it authorises hosts or paths that were never intended.',
    remediation:
      'Replace the wildcard entry with one exact, fully qualified URL for each callback the application actually uses.',
  },
  'OCS-003': {
    reason:
      'This project enables the allow-dangerous-redirect setting, so this URI is accepted as a text prefix rather than an exact string. Every path that merely starts with it on the same origin is accepted — including a sibling such as /callback-evil for a registered /callback — and the query string is not compared at all.',
    remediation:
      'Register exact callback URLs for every client in this project, then disable the allow-dangerous-redirect project setting.',
  },
  'OCS-005': {
    reason:
      'No redirect URI is configured, so this client cannot take part in a redirect-based authorization flow and no redirect risk applies.',
    remediation: 'None required.',
  },
  'OCS-006': {
    reason:
      'This registered redirect URI value cannot be parsed as an absolute URL, so the redirect URI checks could not be applied to it and this client is reported as unevaluated rather than clean. A value a URL parser rejects is still stored, is still compared against an incoming authorization request as an exact string, and can carry invisible characters that make it read as a different address than the one registered.',
    remediation:
      'Inspect the stored value directly rather than the text shown here, then remove the entry or replace it with one exact, fully qualified callback URL — for example https://app.example.com/oauth/callback.',
  },
};

const REGISTRATION_DISCOVERABLE_COPY: Record<RegistrationDiscoverableClient['source'], OAuthClientLintCopy> = {
  config: {
    reason:
      "A value belonging to this client also identifies a client in this server's configured default OAuth client list, which POST /oauth2/register serves without authentication: a caller presenting a matching redirect URI receives that client's id and its complete redirect URI list. No client secret is returned by that endpoint.",
    remediation:
      "Ask the server operator to confirm that this client is meant to be reachable through unauthenticated registration, and to remove the matching entry from the server's default OAuth client configuration if it is not.",
  },
  'built-in': {
    reason:
      "A value belonging to this client also matches the server's built-in Medplum CLI client, which POST /oauth2/register serves without authentication: a caller presenting a matching redirect URI receives that built-in client's id and redirect URI list rather than this client's. No client secret is returned by that endpoint.",
    remediation:
      'The built-in client cannot be removed by configuration. Register a redirect URI that does not collide with it — the built-in client uses the loopback URI http://localhost:9615 — and give this client an id of its own.',
  },
};

const STATUS_RANK: Record<OAuthClientLintStatus, number> = {
  pass: 0,
  warning: 1,
  fail: 2,
};

const LOOPBACK_HOSTNAMES: string[] = ['localhost', '127.0.0.1', '[::1]'];

function parseRedirectUri(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
}

/**
 * One registered entry standing for a `redirectUris` field that is stored as something other than a list, which no
 * URI-scoped rule can evaluate and which carries no registered value of its own.
 */
const MALFORMED_REDIRECT_URIS_FIELD = Symbol('malformedRedirectUrisField');

/**
 * Collects the registered redirect URI entries of a client application as they are stored, without assuming that
 * every entry is a string or that `redirectUris` holds a list.
 * @param client - The client application to read, including the deprecated singular `redirectUri` field.
 * @returns The registered entries in registration order: the deprecated singular `redirectUri` first, then either the
 * `redirectUris` members or, when that field is not stored as a list, the single
 * {@link MALFORMED_REDIRECT_URIS_FIELD} entry.
 */
function getRegisteredRedirectUriEntries(client: ClientApplication): unknown[] {
  const registered: unknown = client.redirectUris;
  if (registered && !Array.isArray(registered)) {
    const entries: unknown[] = [];
    if (client.redirectUri) {
      entries.push(client.redirectUri);
    }
    entries.push(MALFORMED_REDIRECT_URIS_FIELD);
    return entries;
  }
  return getClientRedirectUris(client);
}

/**
 * Reduces a registered redirect URI list to the values the URI-scoped rules are evaluated against.
 * @param redirectUris - The registered redirect URI entries, in registration order.
 * @returns The distinct entries, each in the position of its first occurrence.
 */
function distinctRedirectUris<T>(redirectUris: readonly T[]): T[] {
  return Array.from(new Set(redirectUris));
}

/**
 * Determines whether a parsed redirect URI is an origin with no callback path on a non-loopback host.
 * @param url - The parsed redirect URI.
 * @returns True when the URI carries no path beyond the root on a non-loopback host.
 */
function isBareOrigin(url: URL): boolean {
  if (url.pathname !== '' && url.pathname !== '/') {
    return false;
  }
  return !LOOPBACK_HOSTNAMES.includes(url.hostname);
}

/**
 * Builds one finding.
 * @param ruleId - The rule that produced the finding.
 * @param status - The severity of the finding.
 * @param copy - The reason and remediation text for the finding.
 * @param redirectUri - The registered redirect URI that triggered the finding, when the finding is scoped to a URI.
 * @returns The finding, carrying a `redirectUri` key only when one was supplied.
 */
function createFinding(
  ruleId: OAuthClientLintRuleId,
  status: OAuthClientLintStatus,
  copy: OAuthClientLintCopy,
  redirectUri?: string
): OAuthClientLintFinding {
  if (redirectUri === undefined) {
    return { ruleId, status, reason: copy.reason, remediation: copy.remediation };
  }
  return { ruleId, status, redirectUri, reason: copy.reason, remediation: copy.remediation };
}

/**
 * Finds the first registration-discoverable client that shares a redirect URI or an id with the client application.
 *
 * Entries are resolved in registration order, and a redirect URI match takes precedence over an id match within the
 * same entry.
 * @param clientId - The id of the client application.
 * @param redirectUris - The distinct registered redirect URIs of the client application, in first occurrence order.
 * @param entries - Standard OAuth clients in the order registration resolves them.
 * @returns A single finding for the first matching entry, or undefined when no entry matches.
 */
function lintRegistrationDiscoverable(
  clientId: string,
  redirectUris: string[],
  entries: readonly RegistrationDiscoverableClient[]
): OAuthClientLintFinding | undefined {
  for (const entry of entries) {
    const matchedUri = redirectUris.find((redirectUri) => entry.redirectUris.includes(redirectUri));
    if (matchedUri === undefined && entry.id !== clientId) {
      continue;
    }
    return createFinding(
      OAuthClientLintRule.RegistrationDiscoverable,
      'warning',
      REGISTRATION_DISCOVERABLE_COPY[entry.source],
      matchedUri
    );
  }
  return undefined;
}

/**
 * Reduces a set of findings to a single status.
 * @param findings - The findings emitted for one client application.
 * @returns The highest severity among the findings, or `pass` when there are none.
 */
function aggregateStatus(findings: readonly OAuthClientLintFinding[]): OAuthClientLintStatus {
  let aggregate: OAuthClientLintStatus = 'pass';
  for (const finding of findings) {
    if (STATUS_RANK[finding.status] > STATUS_RANK[aggregate]) {
      aggregate = finding.status;
    }
  }
  return aggregate;
}

/**
 * Evaluates the redirect URI configuration of one OAuth client application.
 *
 * The evaluation is deterministic and free of side effects: it reads only the client application and the options
 * passed to it, performs no I/O, and does not modify either argument.
 * @param client - The client application to evaluate, including the deprecated singular `redirectUri` field.
 * @param options - Evaluation inputs supplied by the caller. Both members are optional; an absent member disables the
 * rules that depend on it.
 * @returns The client identity fields, every registered redirect URI stored as a string in registration order
 * including any repeated entry, every finding in deterministic emission order — exactly one per matching rule and
 * distinct registered entry pair for the URI-scoped rules, in first occurrence order of the entry, followed by the at
 * most two client-level findings — and the aggregate status. A registered entry that is not a string, or that is a
 * string no absolute URL can be parsed from, carries an `OCS-006` finding instead of the rules that need a parsed URL.
 */
export function lintOAuthClient(
  client: WithId<ClientApplication>,
  options?: OAuthClientLintOptions
): OAuthClientLintResult {
  const registeredEntries = getRegisteredRedirectUriEntries(client);
  const redirectUris = registeredEntries.filter((entry): entry is string => typeof entry === 'string');
  const partialRedirectMatchEnabled = options?.partialRedirectMatchEnabled === true;
  const findings: OAuthClientLintFinding[] = [];

  for (const entry of distinctRedirectUris(registeredEntries)) {
    const redirectUri = typeof entry === 'string' ? entry : undefined;
    const url = redirectUri === undefined ? undefined : parseRedirectUri(redirectUri);
    if (url === undefined) {
      findings.push(
        createFinding(
          OAuthClientLintRule.UnparseableRedirectUri,
          'warning',
          LINT_COPY[OAuthClientLintRule.UnparseableRedirectUri],
          redirectUri
        )
      );
    } else if (isBareOrigin(url)) {
      findings.push(
        createFinding(
          OAuthClientLintRule.BareOrigin,
          partialRedirectMatchEnabled ? 'fail' : 'warning',
          LINT_COPY[OAuthClientLintRule.BareOrigin],
          redirectUri
        )
      );
    }
    if (redirectUri?.includes('*')) {
      findings.push(
        createFinding(OAuthClientLintRule.Wildcard, 'fail', LINT_COPY[OAuthClientLintRule.Wildcard], redirectUri)
      );
    }
    if (partialRedirectMatchEnabled && url !== undefined) {
      findings.push(
        createFinding(
          OAuthClientLintRule.PrefixMatchingEnabled,
          'fail',
          LINT_COPY[OAuthClientLintRule.PrefixMatchingEnabled],
          redirectUri
        )
      );
    }
  }

  const registrationDiscoverableClients = options?.registrationDiscoverableClients;
  if (registrationDiscoverableClients !== undefined) {
    const finding = lintRegistrationDiscoverable(
      client.id,
      distinctRedirectUris(redirectUris),
      registrationDiscoverableClients
    );
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  if (registeredEntries.length === 0) {
    findings.push(
      createFinding(OAuthClientLintRule.NoRedirectUri, 'pass', LINT_COPY[OAuthClientLintRule.NoRedirectUri])
    );
  }

  return {
    id: client.id,
    ...(client.name === undefined ? {} : { name: client.name }),
    redirectUris,
    status: aggregateStatus(findings),
    findings,
  };
}

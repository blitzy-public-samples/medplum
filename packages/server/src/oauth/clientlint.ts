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
 * Rule identifiers that {@link lintOAuthClient} can emit.
 */
export const OAuthClientLintRule = {
  BareOrigin: 'OCS-001',
  Wildcard: 'OCS-002',
  PrefixMatchingEnabled: 'OCS-003',
  RegistrationDiscoverable: 'OCS-004',
  NoRedirectUri: 'OCS-005',
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
  /** The registered redirect URI that triggered the finding. Absent when the finding is not scoped to a URI. */
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

/**
 * The complete evaluation of one client application.
 */
export interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
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

/**
 * Parses a registered redirect URI.
 * @param uri - The registered redirect URI.
 * @returns The parsed URL, or undefined when the value cannot be parsed.
 */
function parseRedirectUri(uri: string): URL | undefined {
  try {
    return new URL(uri);
  } catch {
    return undefined;
  }
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
 * @param clientId - The id of the client application.
 * @param redirectUris - The registered redirect URIs of the client application.
 * @param entries - Standard OAuth clients in the order registration resolves them.
 * @returns A single finding for the first matching entry, or undefined when no entry matches.
 */
function lintRegistrationDiscoverable(
  clientId: string,
  redirectUris: string[],
  entries: readonly RegistrationDiscoverableClient[]
): OAuthClientLintFinding | undefined {
  for (const entry of entries) {
    const matchedUri = redirectUris.find((uri) => entry.redirectUris.includes(uri));
    if (matchedUri !== undefined) {
      return createFinding(
        OAuthClientLintRule.RegistrationDiscoverable,
        'warning',
        REGISTRATION_DISCOVERABLE_COPY[entry.source],
        matchedUri
      );
    }
    if (entry.id !== undefined && entry.id === clientId) {
      return createFinding(
        OAuthClientLintRule.RegistrationDiscoverable,
        'warning',
        REGISTRATION_DISCOVERABLE_COPY[entry.source]
      );
    }
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
 * @returns The client identity fields, one finding per matched rule in emission order, and the aggregate status.
 */
export function lintOAuthClient(
  client: WithId<ClientApplication>,
  options?: OAuthClientLintOptions
): OAuthClientLintResult {
  const redirectUris = getClientRedirectUris(client);
  const partialRedirectMatchEnabled = options?.partialRedirectMatchEnabled === true;
  const findings: OAuthClientLintFinding[] = [];

  for (const redirectUri of redirectUris) {
    const url = parseRedirectUri(redirectUri);
    if (url !== undefined && isBareOrigin(url)) {
      findings.push(
        createFinding(
          OAuthClientLintRule.BareOrigin,
          partialRedirectMatchEnabled ? 'fail' : 'warning',
          LINT_COPY[OAuthClientLintRule.BareOrigin],
          redirectUri
        )
      );
    }
    if (redirectUri.includes('*')) {
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
    const finding = lintRegistrationDiscoverable(client.id, redirectUris, registrationDiscoverableClients);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  if (redirectUris.length === 0) {
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

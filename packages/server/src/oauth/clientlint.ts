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
  EvaluationTruncated: 'OCS-006',
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
 * The evaluation of one client application.
 */
export interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  /** The registered redirect URIs the evaluation read: a leading run of the full list, in registration order. */
  readonly redirectUris: string[];
  /**
   * True when a ceiling in {@link OAUTH_CLIENT_LINT_BUDGET} stopped the evaluation, in which case `findings` also
   * carries an `OCS-006` finding. Absent when every registered redirect URI was read.
   */
  readonly truncated?: boolean;
  /** The number of redirect URIs the client registers. Present only alongside `truncated`. */
  readonly redirectUriCount?: number;
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
 * The registration-discoverable clients of one server, prepared for repeated evaluation by
 * {@link indexRegistrationDiscoverableClients}.
 */
export interface RegistrationDiscoverableClientIndex {
  /** The entries the index was built from, in the order registration resolves them. */
  readonly entries: readonly RegistrationDiscoverableClient[];
  /** The position in `entries` of the first entry that registers each redirect URI. */
  readonly uriPositions: ReadonlyMap<string, number>;
  /** The position in `entries` of the first entry that declares each client id. */
  readonly idPositions: ReadonlyMap<string, number>;
}

/**
 * Evaluation inputs for {@link lintOAuthClient} that the client application resource does not carry.
 */
export interface OAuthClientLintOptions {
  /** True when the project enables the `allow-dangerous-redirect` setting. */
  readonly partialRedirectMatchEnabled?: boolean;
  /**
   * Standard OAuth clients in the order registration resolves them, either as a list or as the index
   * {@link indexRegistrationDiscoverableClients} builds from one. A caller evaluating several client applications
   * against the same list passes the index, which is built once and read by every evaluation.
   */
  readonly registrationDiscoverableClients?:
    readonly RegistrationDiscoverableClient[] | RegistrationDiscoverableClientIndex;
}

/**
 * The ceilings one {@link lintOAuthClient} call applies to a single client application: the registered redirect URIs
 * it reads, the UTF-8 bytes those URIs may span, and the findings it emits. Each ceiling is tested before a URI is
 * read, so `findings` never exceeds `maxFindings` and `redirectUris` never spans more than `maxRedirectUriBytes`
 * bytes. A result that stopped at a ceiling carries `truncated`, `redirectUriCount` and an `OCS-006` finding.
 */
export const OAUTH_CLIENT_LINT_BUDGET = {
  maxRedirectUris: 20,
  maxRedirectUriBytes: 4096,
  maxFindings: 40,
} as const;

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
      'This review did not read every redirect URI registered for this client, so the result is incomplete: the redirect URIs it did not read were not evaluated, and any risk they carry is not reported here. The redirect URIs listed for this client are the ones that were read.',
    remediation:
      'Remove the redirect URIs this client no longer uses, and shorten any unusually long entry, so that the whole list can be reviewed — then open this report again.',
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

/** The number of findings one registered redirect URI can produce: `OCS-001`, `OCS-002` and `OCS-003`. */
const MAX_FINDINGS_PER_REDIRECT_URI = 3;

/** The number of findings emitted after the redirect URIs: `OCS-004`, and one of `OCS-005` or `OCS-006`. */
const MAX_CLIENT_LEVEL_FINDINGS = 2;

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
/**
 * Counts the redirect URIs a client application registers, without reading them.
 * @param client - The client application.
 * @returns The number of registered redirect URIs, including the deprecated singular field.
 */
function countRegisteredRedirectUris(client: ClientApplication): number {
  return (client.redirectUri ? 1 : 0) + (client.redirectUris?.length ?? 0);
}

/**
 * Reads the leading redirect URIs a client application registers, at most `maxRedirectUris` of them.
 * @param client - The client application.
 * @returns The registered redirect URIs, the deprecated singular field first, truncated to the count ceiling.
 */
function readRedirectUriPrefix(client: WithId<ClientApplication>): string[] {
  const limit = OAUTH_CLIENT_LINT_BUDGET.maxRedirectUris;
  if (countRegisteredRedirectUris(client) <= limit) {
    return getClientRedirectUris(client);
  }
  return getClientRedirectUris({ ...client, redirectUris: client.redirectUris?.slice(0, limit) }).slice(0, limit);
}

/**
 * Measures the UTF-8 size of a redirect URI against the bytes left in the byte ceiling.
 * @param uri - The registered redirect URI.
 * @param remainingBytes - The number of bytes left in the byte ceiling.
 * @returns The UTF-8 size of the URI, or undefined when the URI does not fit the remaining bytes.
 */
function measureRedirectUriBytes(uri: string, remainingBytes: number): number | undefined {
  if (uri.length > remainingBytes) {
    return undefined;
  }
  const bytes = Buffer.byteLength(uri, 'utf8');
  return bytes > remainingBytes ? undefined : bytes;
}

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
 * Indexes the registration-discoverable clients by redirect URI and by id, first entry wins. The index is
 * independent of any client application, so one index serves every evaluation against the same entries.
 * @param entries - Standard OAuth clients in the order registration resolves them.
 * @returns The entries and the position of the first entry carrying each redirect URI and each id.
 */
export function indexRegistrationDiscoverableClients(
  entries: readonly RegistrationDiscoverableClient[]
): RegistrationDiscoverableClientIndex {
  const uriPositions = new Map<string, number>();
  const idPositions = new Map<string, number>();
  for (let position = 0; position < entries.length; position++) {
    const entry = entries[position];
    for (const uri of entry.redirectUris) {
      if (!uriPositions.has(uri)) {
        uriPositions.set(uri, position);
      }
    }
    if (entry.id !== undefined && !idPositions.has(entry.id)) {
      idPositions.set(entry.id, position);
    }
  }
  return { entries, uriPositions, idPositions };
}

/**
 * Finds the first registration-discoverable client that shares a redirect URI or an id with the client application.
 *
 * Entries are resolved in registration order, and a redirect URI match takes precedence over an id match within the
 * same entry.
 * @param clientId - The id of the client application.
 * @param redirectUris - The registered redirect URIs of the client application that the evaluation read.
 * @param index - The index of the standard OAuth clients registration resolves.
 * @returns A single finding for the first matching entry, or undefined when no entry matches.
 */
function lintRegistrationDiscoverable(
  clientId: string,
  redirectUris: string[],
  index: RegistrationDiscoverableClientIndex
): OAuthClientLintFinding | undefined {
  const { entries, uriPositions, idPositions } = index;
  let matchedPosition: number | undefined;
  let matchedUri: string | undefined;

  for (const uri of redirectUris) {
    const position = uriPositions.get(uri);
    if (position !== undefined && (matchedPosition === undefined || position < matchedPosition)) {
      matchedPosition = position;
      matchedUri = uri;
    }
  }

  const idPosition = idPositions.get(clientId);
  if (idPosition !== undefined && (matchedPosition === undefined || idPosition < matchedPosition)) {
    matchedPosition = idPosition;
    matchedUri = undefined;
  }

  if (matchedPosition === undefined) {
    return undefined;
  }
  return createFinding(
    OAuthClientLintRule.RegistrationDiscoverable,
    'warning',
    REGISTRATION_DISCOVERABLE_COPY[entries[matchedPosition].source],
    matchedUri
  );
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
 * passed to it, performs no I/O, and does not modify either argument. It reads the registered redirect URIs in
 * registration order and stops at the first one that a ceiling of {@link OAUTH_CLIENT_LINT_BUDGET} does not admit.
 * @param client - The client application to evaluate, including the deprecated singular `redirectUri` field.
 * @param options - Evaluation inputs supplied by the caller. Both members are optional; an absent member disables the
 * rules that depend on it.
 * @returns The client identity fields, every finding in deterministic emission order — one per matching rule and
 * redirect URI pair for the URI-scoped rules, in URI order, followed by the at most two client-level findings — the
 * aggregate status, and, where a ceiling stopped the evaluation, `truncated` with the registered redirect URI count.
 */
export function lintOAuthClient(
  client: WithId<ClientApplication>,
  options?: OAuthClientLintOptions
): OAuthClientLintResult {
  const registeredRedirectUriCount = countRegisteredRedirectUris(client);
  const readableRedirectUris = readRedirectUriPrefix(client);
  const partialRedirectMatchEnabled = options?.partialRedirectMatchEnabled === true;
  const findingCeiling =
    OAUTH_CLIENT_LINT_BUDGET.maxFindings - MAX_FINDINGS_PER_REDIRECT_URI - MAX_CLIENT_LEVEL_FINDINGS;
  const findings: OAuthClientLintFinding[] = [];
  const redirectUris: string[] = [];
  let redirectUriBytes = 0;
  let truncated = readableRedirectUris.length < registeredRedirectUriCount;

  for (const redirectUri of readableRedirectUris) {
    if (findings.length > findingCeiling) {
      truncated = true;
      break;
    }
    const uriBytes = measureRedirectUriBytes(
      redirectUri,
      OAUTH_CLIENT_LINT_BUDGET.maxRedirectUriBytes - redirectUriBytes
    );
    if (uriBytes === undefined) {
      truncated = true;
      break;
    }
    redirectUris.push(redirectUri);
    redirectUriBytes += uriBytes;

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
    const index =
      'uriPositions' in registrationDiscoverableClients
        ? registrationDiscoverableClients
        : indexRegistrationDiscoverableClients(registrationDiscoverableClients);
    const finding = lintRegistrationDiscoverable(client.id, redirectUris, index);
    if (finding !== undefined) {
      findings.push(finding);
    }
  }

  if (registeredRedirectUriCount === 0) {
    findings.push(
      createFinding(OAuthClientLintRule.NoRedirectUri, 'pass', LINT_COPY[OAuthClientLintRule.NoRedirectUri])
    );
  } else if (truncated) {
    findings.push(
      createFinding(
        OAuthClientLintRule.EvaluationTruncated,
        'warning',
        LINT_COPY[OAuthClientLintRule.EvaluationTruncated]
      )
    );
  }

  return {
    id: client.id,
    ...(client.name === undefined ? {} : { name: client.name }),
    redirectUris,
    ...(truncated ? { truncated: true, redirectUriCount: registeredRedirectUriCount } : {}),
    status: aggregateStatus(findings),
    findings,
  };
}

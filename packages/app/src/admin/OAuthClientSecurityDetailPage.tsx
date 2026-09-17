// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Alert, Group, Stack, Text, Title } from '@mantine/core';
import { normalizeOperationOutcome } from '@medplum/core';
import type { OperationOutcome } from '@medplum/fhirtypes';
import { Loading, MedplumLink, OperationOutcomeAlert, StatusBadge, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect, useState } from 'react';
import { useParams } from 'react-router';
import { getProjectId } from '../utils';

type OAuthClientLintStatus = 'pass' | 'warning' | 'fail';

interface OAuthClientLintFinding {
  readonly ruleId: string;
  readonly status: OAuthClientLintStatus;
  readonly redirectUri?: string;
  readonly reason: string;
  readonly remediation: string;
}

interface OAuthClientLintResult {
  readonly id: string;
  readonly name?: string;
  readonly redirectUris: string[];
  readonly status: OAuthClientLintStatus;
  readonly findings: OAuthClientLintFinding[];
}

interface OAuthClientLintReport {
  readonly total: number;
  readonly offset: number;
  readonly count: number;
  readonly results: OAuthClientLintResult[];
}

const LIST_PATH = '/admin/oauth-security';

const BADGE_COLORS = {
  pass: 'green',
  warning: 'orange',
  fail: 'red',
} as const;

const ALERT_COLORS = {
  pass: 'green',
  warning: 'yellow',
  fail: 'red',
} as const;

function BackLink(): JSX.Element {
  return <MedplumLink to={LIST_PATH}>Back to OAuth Security</MedplumLink>;
}

function FindingAlert({ finding }: { readonly finding: OAuthClientLintFinding }): JSX.Element {
  return (
    <Alert color={ALERT_COLORS[finding.status]} title={finding.ruleId}>
      {finding.redirectUri && (
        <Text size="sm" fw={500}>
          {finding.redirectUri}
        </Text>
      )}
      <Text size="sm">{finding.reason}</Text>
      <Text size="sm" mt="xs">
        <strong>Suggested fix:</strong> {finding.remediation}
      </Text>
    </Alert>
  );
}

/**
 * Read-only detail view for one OAuth client application in the current project. Lists every
 * finding the project admin OAuth security report returned for the client, naming the redirect
 * URI that triggered it, the reason and the suggested fix.
 * @returns The rendered element.
 */
export function OAuthClientSecurityDetailPage(): JSX.Element {
  const medplum = useMedplum();
  const { clientId } = useParams() as { clientId: string };
  const projectId = getProjectId(medplum);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<OAuthClientLintResult | undefined>();
  const [outcome, setOutcome] = useState<OperationOutcome | undefined>();

  useEffect(() => {
    let active = true;
    medplum
      .get('admin/projects/' + projectId + '/oauth-security?_id=' + clientId, { cache: 'no-cache' })
      .then((report: OAuthClientLintReport) => {
        if (active) {
          setOutcome(undefined);
          setResult(report?.results?.[0]);
        }
      })
      .catch((err: unknown) => {
        if (active) {
          setResult(undefined);
          setOutcome(normalizeOperationOutcome(err));
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [medplum, projectId, clientId]);

  if (loading) {
    return <Loading />;
  }

  if (outcome) {
    return (
      <>
        <BackLink />
        <OperationOutcomeAlert outcome={outcome} mt="md" />
      </>
    );
  }

  if (!result) {
    return (
      <>
        <BackLink />
        <Text c="dimmed" mt="md">
          This OAuth client is not visible in this project.
        </Text>
      </>
    );
  }

  const findings = [...result.findings].sort((a, b) => a.ruleId.localeCompare(b.ruleId));

  return (
    <>
      <Group justify="space-between" mb="md">
        <Title order={4}>{result.name || result.id}</Title>
        <StatusBadge status={result.status} color={BADGE_COLORS[result.status]} variant="light" />
      </Group>
      <BackLink />
      {findings.length === 0 ? (
        <Text c="dimmed" mt="md">
          No risky patterns detected.
        </Text>
      ) : (
        <Stack gap="md" mt="md">
          {findings.map((finding) => (
            <FindingAlert key={finding.ruleId + '|' + (finding.redirectUri ?? '')} finding={finding} />
          ))}
        </Stack>
      )}
    </>
  );
}

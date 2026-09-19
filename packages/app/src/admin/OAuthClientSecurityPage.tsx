// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Text, Title } from '@mantine/core';
import { forbidden } from '@medplum/core';
import { OperationOutcomeAlert, useMedplum } from '@medplum/react';
import type { JSX } from 'react';
import { useEffect } from 'react';
import { OAuthClientSecurityTable } from './OAuthClientSecurityTable';

const PAGE_TITLE = 'OAuth Client Security | Medplum';

/**
 * Renders the read-only OAuth client security review screen for the current project.
 * @returns The page heading, the scope note, and the OAuth client security results table for a project
 * administrator or a super administrator; otherwise a forbidden alert.
 */
export function OAuthClientSecurityPage(): JSX.Element {
  const medplum = useMedplum();

  useEffect(() => {
    const previousTitle = document.title;
    document.title = PAGE_TITLE;
    return () => {
      document.title = previousTitle;
    };
  }, []);

  if (!medplum.isLoading() && !medplum.isProjectAdmin() && !medplum.isSuperAdmin()) {
    return <OperationOutcomeAlert outcome={forbidden} />;
  }

  return (
    <>
      <Title>OAuth Client Security</Title>
      <Text c="dimmed" size="sm" mb="md">
        This is a read-only review. It reports on the OAuth clients you have permission to read in this project.
      </Text>
      <OAuthClientSecurityTable />
    </>
  );
}

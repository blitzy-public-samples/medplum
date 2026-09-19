// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Stack, Text, Title } from '@mantine/core';
import { Document, MedplumLink } from '@medplum/react';
import type { JSX } from 'react';

/**
 * Renders the terminal state for a requested URL that matches no route in the application route table.
 * @returns A not-found heading, an explanation, and a link back to the home page. Takes no props and reads
 * nothing from the requested location, so the rendered output is identical for every unmatched URL.
 */
export function NotFoundPage(): JSX.Element {
  return (
    <Document>
      <Stack>
        <Title order={1}>Page not found</Title>
        <Text>The page you requested does not exist.</Text>
        <Text>
          <MedplumLink to="/">Go to the home page</MedplumLink>
        </Text>
      </Stack>
    </Document>
  );
}

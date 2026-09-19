// SPDX-FileCopyrightText: Copyright Orangebot, Inc. and Medplum contributors
// SPDX-License-Identifier: Apache-2.0
import { Center, Loader } from '@mantine/core';
import type { JSX } from 'react';

/**
 * Centered loading indicator.
 *
 * Geometry contract: the wrapper fills the width and the height of its container and takes the
 * container's own `min-height`. In a full page container such as the app root or `AppShell.Main`,
 * whose `min-height` is the viewport height, the loader is centered in the viewport. In a container
 * with no `min-height` of its own, such as a `Panel` or `Document` on a detail screen, the wrapper
 * adds no height beyond the loader itself.
 *
 * @returns The loading indicator element.
 */
export function Loading(): JSX.Element {
  return (
    <Center w="100%" h="100%" mih="inherit">
      <Loader />
    </Center>
  );
}

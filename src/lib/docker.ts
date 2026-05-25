export type DockerSource = 'default' | 'project' | 'custom';

export const DEFAULT_DOCKER_IMAGE = 'legion-code-agent:latest';
export const PROJECT_DOCKER_IMAGE_PREFIX = 'legion-code-project:';
export const PROJECT_DOCKERFILE_RELATIVE_PATH = '.legion-code/Dockerfile';

export function inferDockerSource(image?: string): DockerSource {
  if (image?.startsWith(PROJECT_DOCKER_IMAGE_PREFIX)) return 'project';
  if (image && image !== DEFAULT_DOCKER_IMAGE) return 'custom';
  return 'default';
}

export function getTaskDockerBadgeLabel(source?: DockerSource): string {
  return source === 'project' ? 'Docker (project)' : 'Docker';
}

export function getTaskDockerOverlayLabel(source?: DockerSource): string {
  return source === 'project' ? 'project dockerfile' : 'docker';
}

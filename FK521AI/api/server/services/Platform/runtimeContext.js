const WORKSPACE_VIRTUAL_ROOT = '/workspace';

const WORKSPACE_VIRTUAL_PATHS = Object.freeze({
  uploads: '/workspace/uploads',
  workdir: '/workspace/workdir',
  projects: '/workspace/projects',
  outputs: '/workspace/outputs',
  manifests: '/workspace/manifests',
});

module.exports = {
  WORKSPACE_VIRTUAL_ROOT,
  WORKSPACE_VIRTUAL_PATHS,
};

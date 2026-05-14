import { connect } from 'framer-api';

export function getFramerConfig() {
  const projectUrl = process.env.FRAMER_PROJECT_URL;
  const token = process.env.FRAMER_TOKEN;
  if (!projectUrl) throw new Error('FRAMER_PROJECT_URL env var is required');
  if (!token) throw new Error('FRAMER_TOKEN env var is required');
  return { projectUrl, token };
}

export async function getFramerClient() {
  const { projectUrl, token } = getFramerConfig();
  return connect(projectUrl, token);
}

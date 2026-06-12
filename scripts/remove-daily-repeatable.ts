import { Queue } from 'bullmq';

async function main() {
  const queue = new Queue('scheduled-runs', {
    connection: {
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT || 6379),
      password: process.env.REDIS_PASSWORD,
      tls: {},
    },
  });

  await queue.removeRepeatableByKey('ecd3fb83d3130b85b82f278622672cd1');
  console.log('removed: ecd3fb83d3130b85b82f278622672cd1');

  const remaining = await queue.getRepeatableJobs();
  for (const j of remaining) {
    console.log('remaining:', j.key, '| pattern:', j.pattern, '| next:', new Date(j.next).toISOString());
  }

  await queue.close();
}

main().then(() => process.exit(0)).catch((err) => {
  console.error(err);
  process.exit(1);
});

const { execSync } = require('child_process');
const path = require('path');

module.exports = async () => {
  require('./env');
  execSync('npx prisma migrate deploy', { cwd: path.join(__dirname, '..'), env: process.env, stdio: 'pipe' });
  const { PrismaClient } = require('@prisma/client');
  const prisma = new PrismaClient();
  await prisma.$executeRawUnsafe('TRUNCATE "Organisation", "User", "LoginEvent", "Plan" CASCADE');
  await prisma.$disconnect();
};

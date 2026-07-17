const bcrypt = require('bcryptjs');
const prisma = require('../src/db');

async function main() {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;
  const name = process.env.SUPER_ADMIN_NAME || 'Super Admin';
  if (!email || !password) {
    console.log('SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD not set; skipping admin seed.');
    return;
  }
  const existing = await prisma.adminUser.findUnique({ where: { email: email.toLowerCase() } });
  if (existing) {
    console.log(`Admin user already exists for ${email}; skipping.`);
    return;
  }
  const admin = await prisma.adminUser.create({
    data: { name, email: email.toLowerCase(), passwordHash: await bcrypt.hash(password, 12) },
  });
  console.log(`Created admin user ${admin.email} (id: ${admin.id}).`);
}

main()
  .catch(error => { console.error(error); process.exitCode = 1; })
  .finally(() => prisma.$disconnect());

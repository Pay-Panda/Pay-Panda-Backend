const { PrismaClient } = require('@prisma/client');

const prisma = global.__payPandaPrisma || new PrismaClient();
if (process.env.NODE_ENV !== 'production') global.__payPandaPrisma = prisma;

module.exports = prisma;

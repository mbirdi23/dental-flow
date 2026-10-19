const { Pool } = require('pg');
require('dotenv').config();

const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL })
  : new Pool({
      host: process.env.PGHOST || 'localhost',
      port: process.env.PGPORT || 5432,
      database: process.env.PGDATABASE || 'dentalflow',
      user: process.env.PGUSER || 'dentalflow',
      password: process.env.PGPASSWORD || 'dentalflow',
    });

module.exports = pool;

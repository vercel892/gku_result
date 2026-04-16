require('dotenv').config();
const { Pool } = require('pg');

const isProduction = process.env.NODE_ENV === 'production' || process.env.VERCEL;

// Help us debug by checking if the variable is found
if (isProduction) {
    if (process.env.POSTGRES_URL) {
        process.stdout.write('[DB] Using POSTGRES_URL from environment.\n');
    } else {
        process.stdout.write('[DB] WARNING: POSTGRES_URL not found in environment!\n');
    }
}

const connectionString =
    process.env.POSTGRES_URL ||
    `postgresql://${process.env.DB_USER || 'postgres'}:${process.env.DB_PASSWORD || 'password'}@${process.env.DB_HOST || 'localhost'}:${process.env.DB_PORT || 5432}/${process.env.DB_NAME || 'gku_db'}`;

const pool = new Pool({
    connectionString,
    max: isProduction ? 5 : 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000, // Increase to 10 seconds
    ssl: isProduction ? { rejectUnauthorized: false } : false,
});

// Show only critical connection errors
pool.on('error', (err) => {
    process.stderr.write(`[DB ERROR] ${err.message}\n`);
});

pool.connect((err, client, release) => {
    if (err) {
        process.stderr.write(
            `[DB] Connection failed: ${err.message}\n` +
            `     Fix: Update POSTGRES_URL in your .env file with the correct password.\n`
        );
    } else {
        process.stdout.write('[DB] PostgreSQL connected.\n');
        release();
    }
});

module.exports = pool;

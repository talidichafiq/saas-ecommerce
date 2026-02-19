-- Migration: 0002_email_verify.sql
-- Adds dedicated email verification columns (separate from password reset)
-- Run: wrangler d1 execute saas-ecommerce-db --file=packages/db/migrations/0002_email_verify.sql

PRAGMA foreign_keys = ON;

ALTER TABLE users ADD COLUMN email_verify_token TEXT;
ALTER TABLE users ADD COLUMN email_verify_expires_at TEXT;

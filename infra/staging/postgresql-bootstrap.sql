\set ON_ERROR_STOP on
\if :{?staging_role}
\else
  \echo 'staging_role is required'
  \quit
\endif
\if :{?staging_database}
\else
  \echo 'staging_database is required'
  \quit
\endif

-- Execute as the RDS administrative identity after replacing neither value in source.
-- The caller supplies psql variables and the password through an out-of-band secret channel.
CREATE ROLE :"staging_role" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT;
CREATE DATABASE :"staging_database" OWNER :"staging_role";
REVOKE ALL ON DATABASE postgres FROM :"staging_role";

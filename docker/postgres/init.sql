-- Runs once, when the data volume is first created.
-- Separate database for integration tests, so tests never wipe dev data.
CREATE DATABASE relayforge_test;

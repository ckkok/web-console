# Yet Another Web Console

So your corporate network team has blocked a common desktop from remote access. Or you need to peer into a network for work purposes (of course) while they've sealed off every port to it without considering how that impacts your team. Or you feel like shells or REPL consoles need to be multiplayer. Whatever the case is, I'm not responsible for how you choose to use this or whether you get fired for even entertaining the thought of using this.

All it is, is yet another web console. There are seriously tonnes of these things around. I just made one for the heck of it. Probably the only difference between this and the rest is the use of Docker containers for shell and REPL access. It's by no means a production-ready system. For that, you would at least need to implement proper authentication system that is at the very least not susceptible to timing attacks, store user credentials in a database instead of a text file, use a distributed in-memory cache for session data, maybe have a better looking front-end, introduce a proper build process, etc.

## Features

- Front-end written with xterm.js and UIkit.
- Server written with ExpressJS and WS.
- Isolated consoles per session provided by Docker containers.
- Uploading of files to containers, with persistence on a per-session basis.
- Session number limiting - block additional clients once a specified maximum number of consoles have been spawned.

Currently stores a single user name and password in plain text (in the `credentials` directory). At least it's hashed and the ExpressJS server is configured for HTTPS.

## Requirements

- NodeJS, tested from v10.15.3 onwards
- Docker Desktop, tested with v2.2.0.3 (42716) onwards - The following images are required for their respective shells/REPLs (configurable) 1. Python REPL: python:3.8-alpine 2. Java REPL: adoptopenjdk:11.0.6_10-jdk-hotspot-bionic 3. Bash Shell: ubuntu:latest 4. NodeJS REPL: node:lts-alpine

## Installation

### Local

1. `git clone`
2. `npm install`
3. Pull the Docker images listed under `Requirements`
4. Generate a user (see below)
5. Generate self-signed certificates for the server (see below)

### AWS

1. `git clone`
2. Generate a user (see below)
3. Generate self-signed certificates for the server (see below)
4. Zip up the directory, excluding `node_modules` and `build`, and include `.ebextensions` and `.npmrc`
5. Upload the archive to an Elastic Beanstalk

## Operation

### Starting the Server

1. Run `npm start` and navigate to `https://localhost:8081`

### Adding a User

1. Run `node generate_credentials.js <username> <password>`

This replaces the current user.

### Generating Self-Signed Certificates for ExpressJS (if you're too cheap to get proper SSL certificates from LetsEncrypt)

1. Run `openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365`
2. Copy the `key.pem` and `cert.pem` files into the `credentials` folder
3. You may need to change the passphrase in `index.js` too

### Configuring Additional Shells

1. Pull in the desired Docker image.
2. Add an entry in the `shells` object in `index.js`
3. Restart the server

## Support

Eh.

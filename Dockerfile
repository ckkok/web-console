FROM node:lts-alpine

WORKDIR /usr/src/app

COPY package.json ./

RUN apk --no-cache --virtual build-dependencies add \
  python \
  make \
  g++ \
  && npm install \
  && apk del build-dependencies

RUN apk add bash bash-doc bash-completion curl less openssh-client util-linux pciutils usbutils coreutils binutils findutils grep

RUN npm install

COPY . .

EXPOSE 8081

CMD ["node", "index.js"]
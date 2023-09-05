FROM node:18-alpine
RUN yarn set version stable

RUN apk update && apk add --no-cache bash
WORKDIR /app
COPY package.json yarn.lock .yarnrc.yml ./
RUN yarn install
COPY . .

ENTRYPOINT ["yarn"]
CMD ["start"]

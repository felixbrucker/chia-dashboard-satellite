FROM node:18-alpine

RUN apk update && apk add --no-cache bash
RUN yarn set version stable
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install
COPY . .

ENTRYPOINT ["yarn"]
CMD ["start"]

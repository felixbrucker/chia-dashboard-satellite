FROM node:14-alpine

RUN apk update && apk add --no-cache bash
WORKDIR /app
COPY package.json yarn.lock ./
RUN yarn install
COPY . .

ENTRYPOINT ["yarn"]
CMD ["start"]

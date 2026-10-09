# Production image: one container serves the website and the authoritative multiplayer server.
# Build:  docker build -t gilli .
# Run:    docker run -p 8080:8080 gilli      -> http://localhost:8080
# Behind a TLS-terminating host (Railway, Render, Fly.io, Azure App Service, a reverse proxy...)
# the browser automatically uses https:// and wss:// because the hub URL is same-origin.

FROM node:22-alpine AS web
WORKDIR /src/client
COPY client/package.json client/package-lock.json ./
RUN npm ci
COPY client/ ./
RUN npm run build

FROM mcr.microsoft.com/dotnet/sdk:10.0 AS server
WORKDIR /src
COPY server/ ./server/
RUN dotnet publish server/Gilli.Server -c Release -o /app

FROM mcr.microsoft.com/dotnet/aspnet:10.0
WORKDIR /app
COPY --from=server /app ./
COPY --from=web /src/client/dist ./wwwroot
ENV ASPNETCORE_URLS=http://+:8080 \
    ASPNETCORE_ENVIRONMENT=Production
EXPOSE 8080
# health probe for the platform: GET /health (the aspnet image has no curl/wget for a Docker HEALTHCHECK)
ENTRYPOINT ["dotnet", "Gilli.Server.dll"]

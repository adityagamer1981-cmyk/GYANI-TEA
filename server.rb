require 'webrick'

root = File.expand_path(__dir__)

mime_types = WEBrick::HTTPUtils::DefaultMimeTypes.merge({
  'png'  => 'image/png',
  'jpg'  => 'image/jpeg',
  'webp' => 'image/webp',
  'html' => 'text/html; charset=utf-8',
  'css'  => 'text/css; charset=utf-8',
  'js'   => 'application/javascript; charset=utf-8'
})

def create_server(port, root, mime_types)
  server = WEBrick::HTTPServer.new(
    Port: port,
    BindAddress: '0.0.0.0',
    DocumentRoot: root,
    MimeTypes: mime_types,
    MaxClients: 100,
    Logger: WEBrick::Log.new($stdout, WEBrick::Log::INFO),
    AccessLog: [[$stdout, WEBrick::AccessLog::COMBINED_LOG_FORMAT]]
  )

  server.mount('/', WEBrick::HTTPServlet::FileHandler, root, {
    HandlerCallback: proc do |req, res|
      res['Access-Control-Allow-Origin'] = '*'
      if req.path.end_with?('.png', '.jpg', '.webp')
        res['Cache-Control'] = 'public, max-age=31536000, immutable'
      elsif req.path == '/' || req.path.end_with?('.html')
        res['Cache-Control'] = 'no-cache, no-store, must-revalidate'
      end
    end
  })

  server
end

server3000 = create_server(3000, root, mime_types)
server8080 = create_server(8080, root, mime_types)

trap('INT')  { server3000.shutdown; server8080.shutdown }
trap('TERM') { server3000.shutdown; server8080.shutdown }

puts "=== Scroll Animation Server Running ==="
puts "URL: http://localhost:3000"
puts "URL: http://localhost:8080"
puts "URL: http://127.0.0.1:3000"
puts "URL: http://127.0.0.1:8080"
STDOUT.flush

t1 = Thread.new { server3000.start }
t2 = Thread.new { server8080.start }

t1.join
t2.join

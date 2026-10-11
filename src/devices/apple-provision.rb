# Mason owns this provisioning operation. No source or signing-repository commits are made.
require 'json'
require 'logger'
require 'fileutils'
require 'digest'
require 'base64'
require 'spaceship'
request = JSON.parse(File.read(ARGV.fetch(0)))
config = request.fetch('apple')
Spaceship::Client.class_eval do
  def logger
    @private_logger ||= Logger.new(File::NULL)
  end
end
ENV['CI'] = '1'
if config['apiKeyFile']
  Spaceship::ConnectAPI.token = Spaceship::ConnectAPI::Token.from_json_file(config.fetch('apiKeyFile'))
else
  login = JSON.parse(File.read(config.fetch('loginFile')))
  ENV['SPACESHIP_COOKIE_PATH'] = login.fetch('cookieDirectory')
  ENV['FASTLANE_PASSWORD'] = login.fetch('password')
  Spaceship::ConnectAPI.login(login.fetch('username'), login.fetch('password'), use_portal: true, use_tunes: false, portal_team_id: config.fetch('teamId'))
end
all = Spaceship::ConnectAPI::Device.all
states = []
request.fetch('devices').each do |device|
  remote = all.find { |d| d.udid.upcase == device.fetch('udid').upcase }
  remote ||= Spaceship::ConnectAPI::Device.create(name: device.fetch('name')[0,50], udid: device.fetch('udid'), platform: 'IOS')
  all << remote unless all.any? { |d| d.id == remote.id }
  states << {id: device.fetch('id'), status: remote.enabled? ? 'registered' : 'processing', message: remote.enabled? ? '' : 'Apple is processing device registration. Mason will retry automatically.'}
end
cert = Spaceship::ConnectAPI::Certificate.all.find { |c| c.id == config.fetch('certificateId') && c.valid? }
raise 'Configured distribution certificate unavailable' unless cert
active = all.select { |d| d.enabled? && d.platform == 'IOS' }
revision = Digest::SHA256.hexdigest(active.map { |d| d.udid.upcase }.sort.join('\n'))[0,16]
folder = File.join(request.fetch('directory'), revision)
FileUtils.mkdir_p(folder, mode: 0700)
profiles = []
request.fetch('apps').each do |app|
  bundle = Spaceship::ConnectAPI::BundleId.find(app)
  raise 'App identifier unavailable' unless bundle
  name = "Mason #{app} #{revision}"
  profile = Spaceship::ConnectAPI::Profile.all(filter: {name:name}, includes: 'bundleId,certificates,devices').find do |p|
    p.name == name && p.valid? && p.bundle_id&.identifier == app && p.certificates.any? { |c| c.id == cert.id } && (active.map(&:id) - p.devices.map(&:id)).empty?
  end
  profile ||= Spaceship::ConnectAPI::Profile.create(name:name, profile_type:'IOS_APP_ADHOC', bundle_id_id:bundle.id, certificate_ids:[cert.id], device_ids:active.map(&:id))
  file = File.join(folder, app+'.mobileprovision')
  File.write(file, Base64.decode64(profile.profile_content), mode:'wb', perm:0600)
  profiles << {app:app, name:name, file:file, sha256:Digest::SHA256.file(file).hexdigest}
end
puts JSON.generate({revision:revision, devices:states, profiles:profiles, udids:active.map(&:udid)})

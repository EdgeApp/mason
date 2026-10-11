# Invoked only by a Mason-configured bundle shim. Existing builds continue to
# use immutable manifests; updated profiles never overwrite a signing repo.
require 'json'
require 'fileutils'
require 'digest'
bundle, manifest_file, *arguments = ARGV
unless arguments[0,2] == ['exec','ruby'] && arguments[3] == 'match'
  exec(bundle, *arguments)
end
abort 'Signing helper failed' unless system(bundle, *arguments)
[manifest_file, File.dirname(manifest_file)].each do |file|
  stat = File.lstat(file)
  abort 'Unsafe signing cache' if stat.symlink? || stat.uid != Process.uid || (stat.mode & 0077) != 0
end
config = JSON.parse(File.read(arguments.fetch(4)))
manifest = JSON.parse(File.read(manifest_file))
profiles = config.fetch('appIds').map { |id| manifest.fetch('profiles').find { |p| p.fetch('app') == id } }
abort 'Signing cache missing an app' if profiles.any?(&:nil?)
destination = config.fetch('profilesDirectory')
stat = File.lstat(destination)
abort 'Unsafe profile destination' unless stat.directory? && !stat.symlink? && stat.uid == Process.uid && (stat.mode & 0077) == 0
profiles.each do |p|
  source = p.fetch('file')
  abort 'Profile outside cache' unless File.dirname(source) == File.dirname(manifest_file)
  stat = File.lstat(source)
  abort 'Unsafe profile file' unless stat.file? && !stat.symlink? && stat.uid == Process.uid && (stat.mode & 0077) == 0
  abort 'Signing profile changed' unless Digest::SHA256.file(source).hexdigest == p.fetch('sha256')
end
Dir.glob(File.join(destination,'*.mobileprovision')).each { |file| File.unlink(file) }
profiles.each { |p| FileUtils.copy_file(p.fetch('file'), File.join(destination, File.basename(p.fetch('file')))); File.chmod(0600,File.join(destination,File.basename(p.fetch('file')))) }

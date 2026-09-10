#!/usr/bin/env ruby
# frozen_string_literal: true

require 'xcodeproj'

project_path, team_id, marketing_version, build_number,
  app_bundle_id, app_profile_name, app_profile_uuid,
  share_bundle_id, share_profile_name, share_profile_uuid = ARGV

required = {
  project_path: project_path,
  team_id: team_id,
  marketing_version: marketing_version,
  build_number: build_number,
  app_bundle_id: app_bundle_id,
  app_profile_name: app_profile_name,
  app_profile_uuid: app_profile_uuid,
  share_bundle_id: share_bundle_id,
  share_profile_name: share_profile_name,
  share_profile_uuid: share_profile_uuid
}
required.each { |name, value| abort("missing #{name}") if value.nil? || value.empty? }
abort('invalid build number') unless build_number.match?(/\A[1-9][0-9]*(?:\.[0-9]+){0,2}\z/)

profiles = {
  app_bundle_id => [app_profile_name, app_profile_uuid],
  share_bundle_id => [share_profile_name, share_profile_uuid]
}
project = Xcodeproj::Project.open(project_path)
matched = []

project.targets.each do |target|
  bundle_ids = target.build_configurations.map { |config| config.build_settings['PRODUCT_BUNDLE_IDENTIFIER'] }.uniq
  bundle_id = bundle_ids.find { |value| profiles.key?(value) }
  next unless bundle_id

  profile_name, profile_uuid = profiles.fetch(bundle_id)
  target.build_configurations.each do |config|
    settings = config.build_settings
    settings['CODE_SIGN_STYLE'] = 'Manual'
    settings['DEVELOPMENT_TEAM'] = team_id
    settings['CODE_SIGN_IDENTITY'] = 'Apple Distribution'
    settings['CODE_SIGN_IDENTITY[sdk=iphoneos*]'] = 'Apple Distribution'
    settings['PROVISIONING_PROFILE'] = profile_uuid
    settings['PROVISIONING_PROFILE_SPECIFIER'] = profile_name
    settings['CURRENT_PROJECT_VERSION'] = build_number
    settings['MARKETING_VERSION'] = marketing_version
  end
  matched << [target.name, bundle_id]
end

abort("expected two signed targets, found #{matched.length}") unless matched.length == 2
abort('signed target bundle IDs do not match requested identities') unless matched.map(&:last).sort == profiles.keys.sort
project.save
matched.each { |target, bundle| puts("configured signing target=#{target} bundle=#{bundle}") }
